import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import { ROUTE_PATHS } from "@/routes/routes.consts";
import { AUTH_RETURN_TO_KEY } from "../auth-storage";
import { isOidcAuthEnabled } from "../authConfig";
import { useAuth } from "../hooks/useAuth";
import { startOidcLogin } from "../keycloak/oidcSession";
import { AppAuthGate } from "./AppAuthGate";

vi.mock("../authConfig", () => ({
  isOidcAuthEnabled: vi.fn(),
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../keycloak/oidcSession", () => ({
  startOidcLogin: vi.fn(),
}));

const mockNavigate = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderGate(initialEntries: string[] = ["/toolsets"]): void {
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route element={<AppAuthGate />}>
          <Route path="toolsets" element={<div>App content</div>} />
          <Route path={ROUTE_PATHS.OVERVIEW.slice(1)} element={<div data-testid="overview-route">Overview</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const BASE_AUTH = {
  isAuthenticated: false,
  loading: false,
  roles: [] as string[],
  permissions: [] as string[],
  token: null,
  user: null,
  error: null,
  logout: async () => {},
  checkAuth: async () => {},
  refreshToken: async () => null,
};

describe("AppAuthGate", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    sessionStorage.clear();
    vi.mocked(startOidcLogin).mockClear();
    vi.mocked(useAuth).mockReturnValue(BASE_AUTH);
    vi.mocked(startOidcLogin).mockResolvedValue(undefined);
  });

  it("renders child routes when OIDC is disabled", () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(false);

    renderGate(["/toolsets"]);

    expect(screen.getByText("App content")).toBeInTheDocument();
    expect(startOidcLogin).not.toHaveBeenCalled();
  });

  it("shows signing-in spinner while auth is loading", () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      loading: true,
    });

    renderGate();

    expect(screen.getByText("Signing in")).toBeInTheDocument();
    expect(startOidcLogin).not.toHaveBeenCalled();
  });

  it("navigates to overview before login when unauthenticated off overview", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: false,
      token: null,
    });

    renderGate();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(ROUTE_PATHS.OVERVIEW, { replace: true });
    });
    expect(sessionStorage.getItem(AUTH_RETURN_TO_KEY)).toBe("/toolsets");
    expect(startOidcLogin).not.toHaveBeenCalled();
  });

  it("navigates to overview when unauthenticated at the root path", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: false,
      loading: false,
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppAuthGate />}>
            <Route path="/" element={<div>Root</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(ROUTE_PATHS.OVERVIEW, { replace: true });
    });
    expect(startOidcLogin).not.toHaveBeenCalled();
  });

  it("starts login when unauthenticated on overview", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: false,
      token: null,
    });

    render(
      <MemoryRouter initialEntries={[ROUTE_PATHS.OVERVIEW]}>
        <Routes>
          <Route element={<AppAuthGate />}>
            <Route path={ROUTE_PATHS.OVERVIEW.slice(1)} element={<div data-testid="overview-route">Overview</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Signing in")).toBeInTheDocument();
    await waitFor(() => {
      expect(startOidcLogin).toHaveBeenCalled();
    });
  });

  it("shows sign-in error panel when login bootstrap rejects", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: false,
      loading: false,
    });
    vi.mocked(startOidcLogin).mockRejectedValueOnce(new Error("bootstrap failed"));

    render(
      <MemoryRouter initialEntries={[ROUTE_PATHS.OVERVIEW]}>
        <Routes>
          <Route element={<AppAuthGate />}>
            <Route path={ROUTE_PATHS.OVERVIEW.slice(1)} element={<div data-testid="overview-route">Overview</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Can’t reach sign-in")).toBeInTheDocument();
      expect(screen.getByText("bootstrap failed")).toBeInTheDocument();
    });
  });

  it("uses generic sign-in error code when rejection is not an Error", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: false,
      loading: false,
    });
    vi.mocked(startOidcLogin).mockRejectedValueOnce("boom");

    render(
      <MemoryRouter initialEntries={[ROUTE_PATHS.OVERVIEW]}>
        <Routes>
          <Route element={<AppAuthGate />}>
            <Route path={ROUTE_PATHS.OVERVIEW.slice(1)} element={<div data-testid="overview-route">Overview</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Can’t reach sign-in")).toBeInTheDocument();
      expect(screen.getByText("sign_in_failed")).toBeInTheDocument();
    });
  });

  it("starts login when unauthenticated on overview with trailing slash", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: false,
      loading: false,
    });

    render(
      <MemoryRouter initialEntries={[`${ROUTE_PATHS.OVERVIEW}/`]}>
        <Routes>
          <Route element={<AppAuthGate />}>
            <Route path={`${ROUTE_PATHS.OVERVIEW.slice(1)}/`} element={<div data-testid="overview-route">Overview</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(startOidcLogin).toHaveBeenCalled();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("treats a basename-prefixed overview path as overview", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: false,
      loading: false,
    });

    render(
      <MemoryRouter initialEntries={[`/studio${ROUTE_PATHS.OVERVIEW}`]}>
        <Routes>
          <Route path="/studio" element={<AppAuthGate />}>
            <Route path={ROUTE_PATHS.OVERVIEW.slice(1)} element={<div data-testid="overview-route">Overview</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(startOidcLogin).toHaveBeenCalled();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("renders access denied without platform roles", () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: true,
      loading: false,
      roles: ["other-role"],
      permissions: [],
      token: "token",
      user: { id: "user-1" },
      error: "AUTH_SESSION_CHECK_FAILED",
    });

    renderGate(["/toolsets"]);

    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(screen.getByText("AUTH_SESSION_CHECK_FAILED")).toBeInTheDocument();
  });

  it("renders outlet when authenticated with platform access", () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      ...BASE_AUTH,
      isAuthenticated: true,
      loading: false,
      roles: ["platform-admin"],
      permissions: ["admin:manage"],
      token: "token",
      user: { id: "user-1" },
      error: null,
    });

    renderGate(["/toolsets"]);

    expect(screen.getByText("App content")).toBeInTheDocument();
  });
});
