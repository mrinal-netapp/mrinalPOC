import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { isOidcAuthEnabled } from "@/contexts/auth/authConfig";
import { completeOidcSilentCallback } from "@/contexts/auth/keycloak/oidcSession";
import { AuthSilentCallbackPage } from "./auth-silent-callback-page";

vi.mock("@/contexts/auth/authConfig", () => ({
  isOidcAuthEnabled: vi.fn(),
}));

vi.mock("@/contexts/auth/keycloak/oidcSession", () => ({
  completeOidcSilentCallback: vi.fn(),
}));

describe("AuthSilentCallbackPage", () => {
  beforeEach(() => {
    vi.mocked(completeOidcSilentCallback).mockResolvedValue({} as never);
  });

  it("does nothing when OIDC is disabled", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(false);

    render(
      <MemoryRouter>
        <AuthSilentCallbackPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Refreshing session")).toBeInTheDocument();
    expect(completeOidcSilentCallback).not.toHaveBeenCalled();
  });

  it("completes silent callback when OIDC is enabled", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);

    render(
      <MemoryRouter>
        <AuthSilentCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(completeOidcSilentCallback).toHaveBeenCalled();
    });
  });

  it("shows failure UI when silent callback throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(completeOidcSilentCallback).mockRejectedValueOnce(new Error("failed"));

    render(
      <MemoryRouter>
        <AuthSilentCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Session refresh failed")).toBeInTheDocument();
    });
  });
});
