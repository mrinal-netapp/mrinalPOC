import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

import { clearAuthTokenBridge, setAuthTokenBridge } from "@/api/api.slice";
import { isOidcAuthEnabled } from "../authConfig";
import { useAuth } from "../hooks/useAuth";
import { startOidcLogin } from "../keycloak/oidcSession";
import { ApiAuthBridge } from "./ApiAuthBridge";

vi.mock("@/api/api.slice", () => ({
  setAuthTokenBridge: vi.fn(),
  clearAuthTokenBridge: vi.fn(),
}));

vi.mock("../authConfig", () => ({
  isOidcAuthEnabled: vi.fn(),
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../keycloak/oidcSession", () => ({
  startOidcLogin: vi.fn(),
}));

describe("ApiAuthBridge", () => {
  beforeEach(() => {
    vi.mocked(setAuthTokenBridge).mockClear();
    vi.mocked(clearAuthTokenBridge).mockClear();
    // startOidcLogin returns Promise<void>; onAuthFailure chains .catch on it.
    vi.mocked(startOidcLogin).mockReset().mockResolvedValue(undefined);
  });

  it("clears the bridge when OIDC is disabled", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(false);
    vi.mocked(useAuth).mockReturnValue({
      token: "ignored",
      user: null,
      refreshToken: async () => null,
      isAuthenticated: false,
      roles: [],
      permissions: [],
      loading: false,
      error: null,
      logout: async () => {},
      checkAuth: async () => {},
    });

    render(
      <ApiAuthBridge>
        <div>child</div>
      </ApiAuthBridge>,
    );

    await waitFor(() => {
      expect(clearAuthTokenBridge).toHaveBeenCalled();
    });
    expect(setAuthTokenBridge).not.toHaveBeenCalled();
  });

  it("registers token bridge when OIDC is enabled", async () => {
    const refreshToken = vi.fn().mockResolvedValue("refreshed-token");
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      token: "access-token",
      user: null,
      refreshToken,
      isAuthenticated: true,
      roles: [],
      permissions: [],
      loading: false,
      error: null,
      logout: async () => {},
      checkAuth: async () => {},
    });

    render(<ApiAuthBridge />);

    await waitFor(() => {
      expect(setAuthTokenBridge).toHaveBeenCalled();
    });

    const bridge = vi.mocked(setAuthTokenBridge).mock.calls.at(-1)?.[0];
    expect(bridge?.getAccessToken()).toBe("access-token");
    await expect(bridge?.refreshToken()).resolves.toBe("refreshed-token");
    expect(refreshToken).toHaveBeenCalled();

    await bridge?.onAuthFailure?.();
    expect(startOidcLogin).toHaveBeenCalled();
  });

  it("clears the bridge when token is null", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(useAuth).mockReturnValue({
      token: null,
      user: null,
      refreshToken: async () => null,
      isAuthenticated: false,
      roles: [],
      permissions: [],
      loading: false,
      error: null,
      logout: async () => {},
      checkAuth: async () => {},
    });

    render(<ApiAuthBridge />);

    await waitFor(() => {
      expect(clearAuthTokenBridge).toHaveBeenCalled();
    });
    expect(setAuthTokenBridge).not.toHaveBeenCalled();
  });
});
