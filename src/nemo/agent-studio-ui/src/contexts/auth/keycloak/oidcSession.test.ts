import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isKeycloakIdpSignoutEnabled } from "../authConfig";
import type { User } from "oidc-client-ts";

const getUserManagerMock = vi.fn();

vi.mock("../authConfig", () => ({
  isKeycloakIdpSignoutEnabled: vi.fn(() => false),
}));

vi.mock("./keycloakConfig", () => ({
  getUserManager: () => getUserManagerMock(),
  resolvePostLogoutRedirectUri: (redirectUri: string) => redirectUri,
}));

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

function createManager(overrides: Record<string, unknown> = {}) {
  return {
    getUser: vi.fn().mockResolvedValue(null),
    signinSilent: vi.fn(),
    signoutRedirect: vi.fn(),
    signoutRedirectCallback: vi.fn(),
    revokeTokens: vi.fn().mockResolvedValue(undefined),
    removeUser: vi.fn().mockResolvedValue(undefined),
    signinRedirect: vi.fn(),
    signinRedirectCallback: vi.fn(),
    signinSilentCallback: vi.fn(),
    ...overrides,
  };
}

async function loadOidcSession() {
  vi.resetModules();
  return import("./oidcSession");
}

describe("oidcSession", () => {
  beforeEach(() => {
    getUserManagerMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mapOidcUserToSession returns null without token or claims", async () => {
    const { mapOidcUserToSession } = await loadOidcSession();
    expect(mapOidcUserToSession(null)).toBeNull();
    expect(mapOidcUserToSession({} as User)).toBeNull();
    expect(mapOidcUserToSession({ access_token: "bad.token.here" } as User)).toBeNull();
  });

  it("mapOidcUserToSession maps a valid user", async () => {
    const token = createTestAccessToken(["platform-admin"]);
    const { mapOidcUserToSession } = await loadOidcSession();

    expect(mapOidcUserToSession({
      access_token: token,
      profile: {
        sub: "profile-user-1",
        name: "Test User",
        given_name: "Test",
        family_name: "User",
        email: "test.user@example.com",
        preferred_username: "test.user",
        "agentstudio.project_id": "project-1",
        "agentstudio.namespace_id": "namespace-1",
      },
    } as unknown as User)).toEqual({
      token,
      user: {
        id: "user-1",
        name: "Test User",
        given_name: "Test",
        family_name: "User",
        email: "test.user@example.com",
      },
      roles: ["platform-admin"],
      permissions: ["admin:manage", "data:read"],
    });
  });

  it("restoreOidcSession delegates to getUser", async () => {
    const token = createTestAccessToken(["platform-member"]);
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue({ access_token: token }),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { restoreOidcSession } = await loadOidcSession();
    const session = await restoreOidcSession();

    expect(session?.roles).toEqual(["platform-member"]);
  });

  it("refreshOidcSession and logout/start login delegate to user manager", async () => {
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(isKeycloakIdpSignoutEnabled).mockReturnValue(true);
    const postLogoutUri = "http://localhost:5175/auth/logout-callback";
    const manager = createManager({
      settings: {
        redirect_uri: "http://localhost:5175/auth/callback",
        post_logout_redirect_uri: postLogoutUri,
      },
      getUser: vi.fn().mockResolvedValue({ id_token: "id-token", access_token: createTestAccessToken(["platform-admin"]) }),
      signinSilent: vi.fn().mockResolvedValue({ access_token: createTestAccessToken(["platform-admin"]) }),
      signoutRedirect: vi.fn().mockResolvedValue(undefined),
      removeUser: vi.fn().mockResolvedValue(undefined),
      signinRedirect: vi.fn().mockResolvedValue(undefined),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { refreshOidcSession, logoutOidcSession, startOidcLogin } = await loadOidcSession();

    await refreshOidcSession();
    const logoutResult = await logoutOidcSession();
    await startOidcLogin();

    expect(manager.signinSilent).toHaveBeenCalled();
    expect(manager.revokeTokens).toHaveBeenCalledWith(["access_token", "refresh_token"]);
    expect(manager.removeUser).toHaveBeenCalled();
    expect(manager.signoutRedirect).toHaveBeenCalledWith({
      id_token_hint: "id-token",
      post_logout_redirect_uri: postLogoutUri,
    });
    expect(logoutResult).toEqual({ endedIdpSession: true });
    expect(manager.signinRedirect).toHaveBeenCalledWith({
      extraQueryParams: { prompt: "login", max_age: "0" },
    });
  });

  it("logoutOidcSession returns local-only result when id token is missing", async () => {
    localStorage.clear();
    sessionStorage.clear();
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue(null),
      removeUser: vi.fn().mockResolvedValue(undefined),
      signoutRedirect: vi.fn(),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { logoutOidcSession } = await loadOidcSession();

    await expect(logoutOidcSession()).resolves.toEqual({ endedIdpSession: false });
    expect(manager.signoutRedirect).not.toHaveBeenCalled();
  });

  it("logoutOidcSession clears oidc keys from localStorage and sessionStorage", async () => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("oidc.user:test", "stale-user");
    sessionStorage.setItem("oidc.state:test", "stale-state");

    const manager = createManager({
      getUser: vi.fn().mockResolvedValue(null),
      removeUser: vi.fn().mockResolvedValue(undefined),
      signoutRedirect: vi.fn(),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { logoutOidcSession } = await loadOidcSession();

    await logoutOidcSession();

    expect(localStorage.getItem("oidc.user:test")).toBeNull();
    expect(sessionStorage.getItem("oidc.state:test")).toBeNull();
    expect(localStorage.getItem("auth.force_login")).toBe("1");
  });

  it("restoreOidcSession returns null while force-login flag is set", async () => {
    localStorage.clear();
    const token = createTestAccessToken(["platform-admin"]);
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue({ access_token: token }),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { markOidcForceLoginOnNextRedirect, restoreOidcSession } = await loadOidcSession();
    markOidcForceLoginOnNextRedirect();

    await expect(restoreOidcSession()).resolves.toBeNull();
    expect(manager.getUser).not.toHaveBeenCalled();
  });

  it("skips signoutRedirect when IdP sign-out is disabled", async () => {
    vi.mocked(isKeycloakIdpSignoutEnabled).mockReturnValue(false);
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue({ id_token: "id-token" }),
      signoutRedirect: vi.fn(),
      removeUser: vi.fn().mockResolvedValue(undefined),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { logoutOidcSession } = await loadOidcSession();

    await expect(logoutOidcSession()).resolves.toEqual({ endedIdpSession: false });
    expect(manager.signoutRedirect).not.toHaveBeenCalled();
  });

  it("logoutOidcSession returns local-only result when signoutRedirect fails", async () => {
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(isKeycloakIdpSignoutEnabled).mockReturnValue(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = createManager({
      settings: {
        redirect_uri: "http://localhost:5175/auth/callback",
        post_logout_redirect_uri: "http://localhost:5175/auth/logout-callback",
      },
      getUser: vi.fn().mockResolvedValue({ id_token: "id-token" }),
      signoutRedirect: vi.fn().mockRejectedValue(new Error("signout failed")),
      removeUser: vi.fn().mockResolvedValue(undefined),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { logoutOidcSession } = await loadOidcSession();

    await expect(logoutOidcSession()).resolves.toEqual({ endedIdpSession: false });
    expect(manager.removeUser).toHaveBeenCalled();
  });

  it("logoutOidcSession derives post logout redirect URI when not configured", async () => {
    vi.mocked(isKeycloakIdpSignoutEnabled).mockReturnValue(true);
    const redirectUri = "http://localhost:5175/auth/callback";
    const manager = createManager({
      settings: {
        redirect_uri: redirectUri,
      },
      getUser: vi.fn().mockResolvedValue({ id_token: "id-token" }),
      signoutRedirect: vi.fn().mockResolvedValue(undefined),
      removeUser: vi.fn().mockResolvedValue(undefined),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { logoutOidcSession } = await loadOidcSession();

    await expect(logoutOidcSession()).resolves.toEqual({ endedIdpSession: true });
    expect(manager.signoutRedirect).toHaveBeenCalledWith({
      id_token_hint: "id-token",
      post_logout_redirect_uri: redirectUri,
    });
  });

  it("logoutOidcSession continues when token revocation fails", async () => {
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(isKeycloakIdpSignoutEnabled).mockReturnValue(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue({ id_token: "id-token" }),
      revokeTokens: vi.fn().mockRejectedValue(new Error("revoke failed")),
      removeUser: vi.fn().mockResolvedValue(undefined),
      signoutRedirect: vi.fn(),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { logoutOidcSession } = await loadOidcSession();

    await expect(logoutOidcSession()).resolves.toEqual({ endedIdpSession: false });
    expect(manager.revokeTokens).toHaveBeenCalledWith(["access_token", "refresh_token"]);
    expect(manager.removeUser).toHaveBeenCalled();
    expect(manager.signoutRedirect).not.toHaveBeenCalled();
  });

  it("logoutOidcSession continues when token revocation hangs", async () => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(isKeycloakIdpSignoutEnabled).mockReturnValue(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue({ id_token: "id-token" }),
      revokeTokens: vi.fn().mockReturnValue(new Promise(() => {})),
      removeUser: vi.fn().mockResolvedValue(undefined),
      signoutRedirect: vi.fn(),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { logoutOidcSession } = await loadOidcSession();
    const logout = logoutOidcSession();

    await vi.advanceTimersByTimeAsync(3_000);

    await expect(logout).resolves.toEqual({ endedIdpSession: false });
    expect(manager.removeUser).toHaveBeenCalled();
    expect(manager.signoutRedirect).not.toHaveBeenCalled();
  });

  it("completeOidcSignoutRedirectCallback runs signoutRedirectCallback and purges storage", async () => {
    localStorage.setItem("oidc.user:test", "stale");
    const manager = createManager({
      signoutRedirectCallback: vi.fn().mockResolvedValue(undefined),
      removeUser: vi.fn().mockResolvedValue(undefined),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { completeOidcSignoutRedirectCallback } = await loadOidcSession();

    await Promise.all([
      completeOidcSignoutRedirectCallback(),
      completeOidcSignoutRedirectCallback(),
    ]);

    expect(manager.signoutRedirectCallback).toHaveBeenCalledTimes(1);
    expect(manager.removeUser).toHaveBeenCalled();
    expect(localStorage.getItem("oidc.user:test")).toBeNull();
  });

  it("startOidcLogin uses default redirect when force login flag is not set", async () => {
    localStorage.clear();
    const manager = createManager({
      signinRedirect: vi.fn().mockResolvedValue(undefined),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { startOidcLogin } = await loadOidcSession();
    await startOidcLogin();

    expect(manager.signinRedirect).toHaveBeenCalledWith();
  });

  it("startOidcLogin keeps prompt=login until auth succeeds", async () => {
    localStorage.clear();
    const manager = createManager({
      signinRedirect: vi.fn().mockResolvedValue(undefined),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { markOidcForceLoginOnNextRedirect, startOidcLogin } = await loadOidcSession();
    markOidcForceLoginOnNextRedirect();

    await startOidcLogin();
    await startOidcLogin();

    expect(manager.signinRedirect).toHaveBeenCalledTimes(2);
    expect(manager.signinRedirect).toHaveBeenNthCalledWith(1, { extraQueryParams: { prompt: "login", max_age: "0" } });
    expect(manager.signinRedirect).toHaveBeenNthCalledWith(2, { extraQueryParams: { prompt: "login", max_age: "0" } });
  });

  it("completeOidcRedirectCallback returns existing user without exchange", async () => {
    const existing = { access_token: createTestAccessToken(["platform-admin"]) } as User;
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue(existing),
      signinRedirectCallback: vi.fn(),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { completeOidcRedirectCallback } = await loadOidcSession();
    await expect(completeOidcRedirectCallback()).resolves.toBe(existing);
    expect(manager.signinRedirectCallback).not.toHaveBeenCalled();
  });

  it("completeOidcRedirectCallback exchanges code and dedupes in-flight calls", async () => {
    const user = { access_token: createTestAccessToken(["platform-admin"]) } as User;
    let resolveCallback: (value: User) => void = () => {};
    const callbackPromise = new Promise<User>((resolve) => {
      resolveCallback = resolve;
    });
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue(null),
      signinRedirectCallback: vi.fn().mockReturnValue(callbackPromise),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { completeOidcRedirectCallback } = await loadOidcSession();
    const first = completeOidcRedirectCallback();
    const second = completeOidcRedirectCallback();

    await Promise.resolve();

    expect(manager.signinRedirectCallback).toHaveBeenCalledTimes(1);

    resolveCallback(user);
    await expect(first).resolves.toBe(user);
    await expect(second).resolves.toBe(user);
  });

  it("completeOidcRedirectCallback throws when exchange returns no user", async () => {
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue(null),
      signinRedirectCallback: vi.fn().mockResolvedValue(null),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { completeOidcRedirectCallback } = await loadOidcSession();
    await expect(completeOidcRedirectCallback()).rejects.toThrow("OIDC redirect callback returned no user");
  });

  it("completeOidcSilentCallback always exchanges even when getUser has a token", async () => {
    const existing = { access_token: createTestAccessToken(["platform-member"]) } as User;
    const renewed = { access_token: createTestAccessToken(["platform-admin"]) } as User;
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue(existing),
      signinSilentCallback: vi.fn().mockResolvedValue(renewed),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { completeOidcSilentCallback } = await loadOidcSession();
    await expect(completeOidcSilentCallback()).resolves.toBe(renewed);
    expect(manager.signinSilentCallback).toHaveBeenCalled();
  });

  it("completeOidcSilentCallback exchanges code and dedupes in-flight calls", async () => {
    const user = { access_token: createTestAccessToken(["platform-member"]) } as User;
    let resolveCallback: (value: User) => void = () => {};
    const callbackPromise = new Promise<User>((resolve) => {
      resolveCallback = resolve;
    });
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue(null),
      signinSilentCallback: vi.fn().mockReturnValue(callbackPromise),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { completeOidcSilentCallback } = await loadOidcSession();
    const first = completeOidcSilentCallback();
    const second = completeOidcSilentCallback();

    await Promise.resolve();

    expect(manager.signinSilentCallback).toHaveBeenCalledTimes(1);

    resolveCallback(user);
    await expect(first).resolves.toBe(user);
    await expect(second).resolves.toBe(user);
  });

  it("completeOidcSilentCallback throws when exchange returns no user", async () => {
    const manager = createManager({
      getUser: vi.fn().mockResolvedValue(null),
      signinSilentCallback: vi.fn().mockResolvedValue(null),
    });
    getUserManagerMock.mockReturnValue(manager);

    const { completeOidcSilentCallback } = await loadOidcSession();
    await expect(completeOidcSilentCallback()).rejects.toThrow("OIDC silent callback returned no user");
  });

});
