import { StrictMode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { AUTH_RETURN_TO_KEY } from "@/contexts/auth/auth-storage";
import { isOidcAuthEnabled } from "@/contexts/auth/authConfig";
import { completeOidcRedirectCallback } from "@/contexts/auth/keycloak/oidcSession";
import { AuthCallbackPage } from "./auth-callback-page";

const navigate = vi.fn();

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock("@/contexts/auth/authConfig", () => ({
  isOidcAuthEnabled: vi.fn(),
}));

vi.mock("@/contexts/auth/keycloak/oidcSession", () => ({
  completeOidcRedirectCallback: vi.fn(),
}));

describe("AuthCallbackPage", () => {
  beforeEach(() => {
    navigate.mockClear();
    sessionStorage.clear();
    vi.mocked(completeOidcRedirectCallback).mockResolvedValue({} as never);
  });

  it("redirects to overview when OIDC is disabled", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(false);

    render(
      <MemoryRouter>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith("/overview", { replace: true });
    });
  });

  it("redirects to overview after post-logout callback without oauth params", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);

    render(
      <MemoryRouter initialEntries={["/auth/callback"]}>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith("/overview", { replace: true });
    });
    expect(completeOidcRedirectCallback).not.toHaveBeenCalled();
  });

  it("completes callback and navigates on success", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);

    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/auth/callback?code=abc&state=xyz"]}>
          <AuthCallbackPage />
        </MemoryRouter>
      </StrictMode>,
    );

    expect(screen.getByText("Completing sign in")).toBeInTheDocument();

    await waitFor(() => {
      expect(completeOidcRedirectCallback).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith("/overview", { replace: true });
    });
  });

  it("returns to the stored deep-link path after callback success", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    sessionStorage.setItem(AUTH_RETURN_TO_KEY, "/agents/invalid-id/edit");

    render(
      <MemoryRouter initialEntries={["/auth/callback?code=abc&state=xyz"]}>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(completeOidcRedirectCallback).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("/agents/invalid-id/edit", { replace: true });
    });
    expect(sessionStorage.getItem(AUTH_RETURN_TO_KEY)).toBeNull();
  });

  it("ignores protocol-relative return paths and falls back to overview", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    sessionStorage.setItem(AUTH_RETURN_TO_KEY, "//evil.example/path");

    render(
      <MemoryRouter initialEntries={["/auth/callback?code=abc&state=xyz"]}>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(completeOidcRedirectCallback).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("/overview", { replace: true });
    });
    expect(sessionStorage.getItem(AUTH_RETURN_TO_KEY)).toBeNull();
  });

  it("ignores auth callback/logout return paths and falls back to overview", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    sessionStorage.setItem(AUTH_RETURN_TO_KEY, "/auth/logout-callback");

    render(
      <MemoryRouter initialEntries={["/auth/callback?code=abc&state=xyz"]}>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(completeOidcRedirectCallback).toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("/overview", { replace: true });
    });
    expect(sessionStorage.getItem(AUTH_RETURN_TO_KEY)).toBeNull();
  });

  it("shows failure UI when callback throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(completeOidcRedirectCallback).mockRejectedValueOnce(new Error("failed"));

    render(
      <MemoryRouter initialEntries={["/auth/callback?code=bad&state=xyz"]}>
        <AuthCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Sign-in failed")).toBeInTheDocument();
    });
  });
});
