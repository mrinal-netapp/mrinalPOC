import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { MemoryRouter } from "react-router";

import { isOidcAuthEnabled } from "@/contexts/auth/authConfig";
import { completeOidcSignoutRedirectCallback } from "@/contexts/auth/keycloak/oidcSession";
import { ROUTE_PATHS } from "@/routes/routes.consts";

import { AuthLogoutCallbackPage } from "./auth-logout-callback-page";

const mockNavigate = vi.fn();
let currentNavigate = mockNavigate;

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useNavigate: () => currentNavigate,
  };
});

vi.mock("@/contexts/auth/authConfig", () => ({
  isOidcAuthEnabled: vi.fn(() => true),
}));

vi.mock("@/contexts/auth/keycloak/oidcSession", () => ({
  completeOidcSignoutRedirectCallback: vi.fn(),
}));

describe("AuthLogoutCallbackPage", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    currentNavigate = mockNavigate;
    vi.mocked(completeOidcSignoutRedirectCallback).mockReset();
    vi.mocked(completeOidcSignoutRedirectCallback).mockResolvedValue(undefined);
  });

  it("redirects to overview when OIDC is disabled", () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(false);

    render(
      <MemoryRouter>
        <AuthLogoutCallbackPage />
      </MemoryRouter>,
    );

    expect(mockNavigate).toHaveBeenCalledWith(ROUTE_PATHS.OVERVIEW, { replace: true });
    expect(completeOidcSignoutRedirectCallback).not.toHaveBeenCalled();
  });

  it("completes sign-out callback and navigates to overview", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);

    render(
      <MemoryRouter>
        <AuthLogoutCallbackPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Signing out")).toBeInTheDocument();

    await waitFor(() => {
      expect(completeOidcSignoutRedirectCallback).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith(ROUTE_PATHS.OVERVIEW, { replace: true });
    });
  });

  it("dedupes sign-out callback completion across same-mount effect reruns", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);

    const { rerender } = render(
      <MemoryRouter>
        <AuthLogoutCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(completeOidcSignoutRedirectCallback).toHaveBeenCalledTimes(1);
    });

    currentNavigate = vi.fn();
    rerender(
      <MemoryRouter>
        <AuthLogoutCallbackPage />
      </MemoryRouter>,
    );

    expect(completeOidcSignoutRedirectCallback).toHaveBeenCalledTimes(1);
  });

  it("navigates to overview when sign-out callback fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(completeOidcSignoutRedirectCallback).mockRejectedValueOnce(new Error("callback failed"));

    render(
      <MemoryRouter>
        <AuthLogoutCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(ROUTE_PATHS.OVERVIEW, { replace: true });
    });
  });
});
