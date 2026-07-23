import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "oidc-client-ts";

import { isOidcAuthEnabled } from "../authConfig";
import { getUserManager, isAuthCallbackPath } from "../keycloak/keycloakConfig";
import { authSessionApi, useAuthSession } from "./useAuthSession";

vi.mock("../authConfig", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../authConfig")>();
  return {
    ...actual,
    isOidcAuthEnabled: vi.fn(() => true),
  };
});

vi.mock("../keycloak/keycloakConfig", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../keycloak/keycloakConfig")>();
  return {
    ...actual,
    getUserManager: vi.fn(),
    isAuthCallbackPath: vi.fn(() => false),
  };
});

function createTestAccessToken(roles: string[]): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const payload = btoa(
    JSON.stringify({
      sub: "user-1",
      realm_access: { roles },
    }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${payload}.sig`;
}

function createMockUserManager(getUserImpl: () => Promise<User | null>) {
  const events = {
    addUserLoaded: vi.fn(),
    removeUserLoaded: vi.fn(),
    addUserUnloaded: vi.fn(),
    removeUserUnloaded: vi.fn(),
    addAccessTokenExpired: vi.fn(),
    removeAccessTokenExpired: vi.fn(),
  };

  return {
    settings: {
      redirect_uri: `${window.location.origin}/auth/callback`,
      post_logout_redirect_uri: `${window.location.origin}/auth/logout-callback`,
    },
    getUser: vi.fn(getUserImpl),
    signinSilent: vi.fn(),
    signoutRedirect: vi.fn(),
    signinRedirect: vi.fn(),
    revokeTokens: vi.fn().mockResolvedValue(undefined),
    removeUser: vi.fn().mockResolvedValue(undefined),
    events,
  };
}

describe("useAuthSession", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(isOidcAuthEnabled).mockReturnValue(true);
    vi.mocked(isAuthCallbackPath).mockReturnValue(false);
    vi.mocked(getUserManager).mockReturnValue(
      createMockUserManager(async () => null) as unknown as ReturnType<typeof getUserManager>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("authSessionApi delegates to OIDC session helpers", async () => {
    vi.stubEnv("VITE_AUTH_ENABLED", "true");
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    vi.stubEnv("VITE_KEYCLOAK_IDP_SIGNOUT", "true");
    const token = createTestAccessToken(["platform-admin"]);
    const postLogoutUri = `${window.location.origin}/auth/logout-callback`;
    const manager = createMockUserManager(async () => ({
      id_token: "id-token",
      access_token: token,
    }) as User);
    manager.settings = {
      redirect_uri: `${window.location.origin}/auth/callback`,
      post_logout_redirect_uri: postLogoutUri,
    };
    manager.signinSilent.mockResolvedValue({ access_token: token });
    manager.signoutRedirect.mockResolvedValue(undefined);
    manager.signinRedirect.mockResolvedValue(undefined);
    vi.mocked(getUserManager).mockReturnValue(
      manager as unknown as ReturnType<typeof getUserManager>,
    );

    await expect(authSessionApi.restoreSession()).resolves.toMatchObject({ token });
    await expect(authSessionApi.refreshSession()).resolves.toMatchObject({ token });
    await expect(authSessionApi.logoutSession()).resolves.toMatchObject({ endedIdpSession: expect.any(Boolean) });
    await authSessionApi.startLogin();

    expect(manager.signinRedirect).toHaveBeenCalledWith({
      extraQueryParams: { prompt: "login", max_age: "0" },
    });
  });

  it("skips OIDC load when auth is disabled via env", async () => {
    vi.mocked(isOidcAuthEnabled).mockReturnValue(false);
    vi.mocked(getUserManager).mockClear();

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(getUserManager).not.toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("skips getUser on auth callback paths", async () => {
    vi.mocked(isAuthCallbackPath).mockReturnValue(true);
    const manager = createMockUserManager(async () => null);
    vi.mocked(getUserManager).mockReturnValue(
      manager as unknown as ReturnType<typeof getUserManager>,
    );

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(manager.getUser).not.toHaveBeenCalled();
  });

  it("sets authenticated state when getUser returns an OIDC user", async () => {
    const accessToken = createTestAccessToken(["platform-admin"]);
    vi.mocked(getUserManager).mockReturnValue(
      createMockUserManager(async () => ({
        access_token: accessToken,
        profile: {
          name: "Test User",
          email: "test.user@example.com",
        },
      }) as User) as unknown as ReturnType<
        typeof getUserManager
      >,
    );

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.token).toBe(accessToken);
    expect(result.current.user).toMatchObject({
      id: "user-1",
      name: "Test User",
      email: "test.user@example.com",
    });
    expect(result.current.roles).toContain("platform-admin");
    expect(result.current.error).toBeNull();
  });

  it("initially resolves to unauthenticated state with empty auth data", async () => {
    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
    expect(result.current.roles).toEqual([]);
    expect(result.current.permissions).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("sets session error when getUser fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getUserManager).mockReturnValue(
      createMockUserManager(async () => {
        throw new Error("boom");
      }) as unknown as ReturnType<typeof getUserManager>,
    );

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("AUTH_SESSION_CHECK_FAILED");
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("clears stored user and session state while force-login is pending", async () => {
    localStorage.setItem("auth.force_login", "1");
    const accessToken = createTestAccessToken(["platform-admin"]);
    const manager = createMockUserManager(async () => ({ access_token: accessToken }) as User);
    vi.mocked(getUserManager).mockReturnValue(
      manager as unknown as ReturnType<typeof getUserManager>,
    );

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(manager.removeUser).toHaveBeenCalled();
    expect(manager.getUser).not.toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
  });

  it("still clears session state when force-login stored user removal fails", async () => {
    localStorage.setItem("auth.force_login", "1");
    const manager = createMockUserManager(async () => ({ access_token: "unused" }) as User);
    manager.removeUser.mockRejectedValueOnce(new Error("remove failed"));
    vi.mocked(getUserManager).mockReturnValue(
      manager as unknown as ReturnType<typeof getUserManager>,
    );

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(manager.removeUser).toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("checkAuth sets error when restoreSession fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(authSessionApi, "restoreSession").mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.checkAuth();
    });

    expect(result.current.error).toBe("AUTH_SESSION_CHECK_FAILED");
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("checkAuth applies restoreSession result", async () => {
    const accessToken = createTestAccessToken(["platform-member"]);
    vi.spyOn(authSessionApi, "restoreSession").mockResolvedValueOnce({
      token: accessToken,
      user: {
        id: "user-1",
        name: "Restored User",
        email: "restored.user@example.com",
      },
      roles: ["platform-member"],
      permissions: ["data:read"],
    });

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.checkAuth();
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.token).toBe(accessToken);
    expect(result.current.user).toMatchObject({
      id: "user-1",
      name: "Restored User",
      email: "restored.user@example.com",
    });
    expect(result.current.roles).toEqual(["platform-member"]);
  });

  it("re-checks auth when returning from the bfcache", async () => {
    const accessToken = createTestAccessToken(["platform-member"]);
    const restoreSpy = vi.spyOn(authSessionApi, "restoreSession").mockResolvedValueOnce({
      token: accessToken,
      user: {
        id: "user-1",
        name: "Restored User",
        email: "restored.user@example.com",
      },
      roles: ["platform-member"],
      permissions: ["data:read"],
    });

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const pageShow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageShow, "persisted", {
      value: true,
    });

    await act(async () => {
      window.dispatchEvent(pageShow);
    });

    await waitFor(() => {
      expect(restoreSpy).toHaveBeenCalled();
      expect(result.current.token).toBe(accessToken);
    });
  });

  it("ignores normal pageshow events that are not bfcache restores", async () => {
    const restoreSpy = vi.spyOn(authSessionApi, "restoreSession").mockResolvedValueOnce(null);

    renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(restoreSpy).not.toHaveBeenCalled();
    });

    const pageShow = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(pageShow, "persisted", {
      value: false,
    });

    await act(async () => {
      window.dispatchEvent(pageShow);
    });

    expect(restoreSpy).not.toHaveBeenCalled();
  });

  it("logout clears auth state and uses Keycloak sign-out when OIDC is enabled", async () => {
    const replaceMock = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, replace: replaceMock },
    });

    const accessToken = createTestAccessToken(["platform-admin"]);
    vi.mocked(getUserManager).mockReturnValue(
      createMockUserManager(async () => ({ access_token: accessToken }) as User) as unknown as ReturnType<
        typeof getUserManager
      >,
    );
    vi.spyOn(authSessionApi, "logoutSession").mockResolvedValueOnce({ endedIdpSession: true });

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.isAuthenticated).toBe(true);
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("logout falls back to overview when IdP sign-out does not navigate", async () => {
    const replaceMock = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, replace: replaceMock },
    });

    const accessToken = createTestAccessToken(["platform-admin"]);
    vi.mocked(getUserManager).mockReturnValue(
      createMockUserManager(async () => ({ access_token: accessToken }) as User) as unknown as ReturnType<
        typeof getUserManager
      >,
    );
    vi.spyOn(authSessionApi, "logoutSession").mockResolvedValueOnce({ endedIdpSession: false });

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.isAuthenticated).toBe(true);
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
    expect(replaceMock).toHaveBeenCalledWith(`${window.location.origin}/overview`);

    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("refreshToken applies session from refreshSession", async () => {
    const accessToken = createTestAccessToken(["platform-member"]);
    vi.spyOn(authSessionApi, "refreshSession").mockResolvedValueOnce({
      token: accessToken,
      user: {
        id: "user-1",
        name: "Refreshed User",
        email: "refreshed.user@example.com",
      },
      roles: ["platform-member"],
      permissions: ["data:read"],
    });

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.refreshToken();
    });

    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.token).toBe(accessToken);
    expect(result.current.user).toMatchObject({
      id: "user-1",
      name: "Refreshed User",
      email: "refreshed.user@example.com",
    });
  });

  it("refreshToken throws when refresh returns no session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(authSessionApi, "refreshSession").mockResolvedValueOnce(null);

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await expect(result.current.refreshToken()).rejects.toThrow("Silent refresh returned no session");
  });

  it("refreshToken clears session and rethrows when refresh fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(authSessionApi, "refreshSession").mockRejectedValueOnce(new Error("refresh failed"));
    const manager = createMockUserManager(async () => null);
    vi.mocked(getUserManager).mockReturnValue(
      manager as unknown as ReturnType<typeof getUserManager>,
    );

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await expect(result.current.refreshToken()).rejects.toThrow("refresh failed");

    expect(manager.removeUser).toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("refreshToken ignores removeUser failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(authSessionApi, "refreshSession").mockRejectedValueOnce(new Error("refresh failed"));
    const manager = createMockUserManager(async () => null);
    manager.removeUser.mockRejectedValueOnce(new Error("remove failed"));
    vi.mocked(getUserManager).mockReturnValue(
      manager as unknown as ReturnType<typeof getUserManager>,
    );

    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await expect(result.current.refreshToken()).rejects.toThrow("refresh failed");
    expect(result.current.isAuthenticated).toBe(false);
  });

  it("wires OIDC user manager events", async () => {
    const accessToken = createTestAccessToken(["platform-admin"]);
    const manager = createMockUserManager(async () => null);
    vi.mocked(getUserManager).mockReturnValue(
      manager as unknown as ReturnType<typeof getUserManager>,
    );

    const { result, unmount } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const loadedHandler = manager.events.addUserLoaded.mock.calls[0]?.[0] as (user: User) => void;
    const unloadedHandler = manager.events.addUserUnloaded.mock.calls[0]?.[0] as () => void;
    const expiredHandler = manager.events.addAccessTokenExpired.mock.calls[0]?.[0] as () => void;

    act(() => {
      loadedHandler({ access_token: accessToken } as User);
    });
    expect(result.current.isAuthenticated).toBe(true);

    act(() => {
      unloadedHandler();
    });
    expect(result.current.isAuthenticated).toBe(false);

    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(authSessionApi, "refreshSession").mockRejectedValueOnce(new Error("expired"));
    vi.spyOn(authSessionApi, "startLogin").mockResolvedValueOnce(undefined);
    await act(async () => {
      expiredHandler();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(authSessionApi.startLogin).toHaveBeenCalled();

    vi.mocked(isAuthCallbackPath).mockReturnValue(true);
    vi.spyOn(authSessionApi, "startLogin").mockClear();
    vi.spyOn(authSessionApi, "refreshSession").mockRejectedValueOnce(new Error("expired on callback"));
    await act(async () => {
      expiredHandler();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(authSessionApi.startLogin).not.toHaveBeenCalled();

    unmount();
    expect(manager.events.removeUserLoaded).toHaveBeenCalled();
    expect(manager.events.removeUserUnloaded).toHaveBeenCalled();
    expect(manager.events.removeAccessTokenExpired).toHaveBeenCalled();
  });

  it("logout throws when logoutSession fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(authSessionApi, "logoutSession").mockRejectedValueOnce(new Error("logout failed"));
    const { result } = renderHook(() => useAuthSession());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await expect(
      act(async () => {
        await result.current.logout();
      }),
    ).rejects.toThrow("logout failed");

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.token).toBeNull();
  });
});
