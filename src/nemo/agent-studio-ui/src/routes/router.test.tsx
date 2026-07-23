import { Outlet } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@test/render";
import { mockFetchSuccess, restoreAllMocks } from "@test/api-mock";
import { ROUTES } from "@/routes/routes.consts";
import { routes } from "@/routes/routes";

vi.mock("@/contexts/auth/guards/AppAuthGate", () => ({
  AppAuthGate: () => <Outlet />,
}));

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
}));

vi.mock("@/contexts/auth/authConfig", () => ({
  isOidcAuthEnabled: vi.fn(() => false),
}));

describe("Router", () => {
  beforeEach(() => {
    mockFetchSuccess({ projects: [] });
  });

  afterEach(() => {
    restoreAllMocks();
  });

  it("[tag:router] should render without crashing", () => {
    const { container } = renderWithProviders(undefined, { routeConfig: routes });
    const mainContent = screen.getByTestId("app-main-content");
    expect(mainContent).toHaveTextContent("Agent Studio: build AI on your data");
    expect(container.firstChild).not.toBeNull();
  });

  it("[tag:router] should redirect root route to overview", () => {
    renderWithProviders(undefined, { routeConfig: routes, initialEntries: ["/"] });
    const mainContent = screen.getByTestId("app-main-content");
    expect(mainContent).toHaveTextContent("Agent Studio: build AI on your data");
  });

  it("[tag:router] should redirect the bare /data-management path to data sources", () => {
    renderWithProviders(undefined, {
      routeConfig: routes,
      initialEntries: [`/${ROUTES.DATA_MANAGEMENT}`],
    });
    expect(screen.getByRole("heading", { name: "Data sources" })).toBeInTheDocument();
  });

  it("[tag:router] should redirect legacy /data-management/data-sources deep links", async () => {
    renderWithProviders(undefined, {
      routeConfig: routes,
      initialEntries: [`/${ROUTES.DATA_MANAGEMENT}/${ROUTES.DATA_SOURCES}`],
    });
    expect(await screen.findByRole("heading", { name: "Data sources" })).toBeInTheDocument();
    expect(screen.queryByText(/Page not found/)).not.toBeInTheDocument();
  });

  it("[tag:router] should redirect legacy /data-management/datasets deep links", async () => {
    renderWithProviders(undefined, {
      routeConfig: routes,
      initialEntries: [`/${ROUTES.DATA_MANAGEMENT}/${ROUTES.DATASETS}`],
    });
    expect(await screen.findByRole("heading", { name: "Datasets" })).toBeInTheDocument();
    expect(screen.queryByText(/Page not found/)).not.toBeInTheDocument();
  });

  it("[tag:router] should not expose example auth sandbox routes", () => {
    const root = routes[0];
    expect(root?.children).toBeDefined();
    const exampleRoute = root?.children?.find((route) => route.path === "example");
    expect(exampleRoute).toBeUndefined();
  });

  it("[tag:router] should register administration and projects routes", () => {
    const rootRoute = routes[0];
    const appGateRoute = rootRoute?.children?.find(
      (route) => route.path == null && Array.isArray(route.children),
    );
    const appRoute = appGateRoute?.children?.find((route) => Array.isArray(route.children));
    const childPaths = appRoute?.children?.map((route) => route.path) ?? [];
    expect(childPaths).toContain("administration");
    expect(childPaths).toContain("projects");
  });

  it("[tag:router] should register toolset routes", () => {
    const rootRoute = routes[0];
    const appGateRoute = rootRoute?.children?.find(
      (route) => route.path == null && Array.isArray(route.children),
    );
    const appRoute = appGateRoute?.children?.find((route) => Array.isArray(route.children));
    const toolsetRoute = appRoute?.children?.find((route) => route.path === ROUTES.TOOLSET);

    expect(toolsetRoute).toBeDefined();
    const addRoute = toolsetRoute?.children?.find(
      (route) => route.path === ROUTES.TOOLSET_ADD_TOOL,
    );
    expect(addRoute).toBeDefined();
  });
});
