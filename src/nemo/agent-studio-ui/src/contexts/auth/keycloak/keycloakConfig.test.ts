import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UserManagerMock = vi.fn(function UserManagerMock() {
  return { getUser: vi.fn() };
});

const WebStorageStateStoreMock = vi.fn(function WebStorageStateStoreMock(
  args: { store: Storage },
) {
  return { store: args.store };
});

vi.mock("oidc-client-ts", () => ({
  UserManager: UserManagerMock,
  WebStorageStateStore: WebStorageStateStoreMock,
}));

describe("keycloakConfig", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete window.__RUNTIME_CONFIG__;
    UserManagerMock.mockClear();
    WebStorageStateStoreMock.mockClear();
  });

  afterEach(() => {
    delete window.__RUNTIME_CONFIG__;
    vi.unstubAllEnvs();
  });

  it("detects auth callback paths", async () => {
    const { isAuthCallbackPath } = await import("./keycloakConfig");
    expect(isAuthCallbackPath("/auth/callback")).toBe(true);
    expect(isAuthCallbackPath("/auth/silent-callback")).toBe(true);
    expect(isAuthCallbackPath("/auth/logout-callback")).toBe(true);
    expect(isAuthCallbackPath("/overview")).toBe(false);
  });

  it("normalizes base path without trailing slash", async () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    vi.stubEnv("VITE_BASE_PATH", "/app");

    const { getKeycloakUserManagerSettings } = await import("./keycloakConfig");
    expect(getKeycloakUserManagerSettings().redirect_uri).toBe(
      `${window.location.origin}/app/auth/callback`,
    );
  });

  it("builds user manager settings from env", async () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo/");
    vi.stubEnv("VITE_KEYCLOAK_CLIENT_ID", "test-client");
    vi.stubEnv("VITE_BASE_PATH", "/app/");

    const { getKeycloakUserManagerSettings } = await import("./keycloakConfig");
    const settings = getKeycloakUserManagerSettings();

    expect(settings.authority).toBe("https://auth.example.com/realms/nemo");
    expect(settings.client_id).toBe("test-client");
    expect(settings.redirect_uri).toBe(`${window.location.origin}/app/auth/callback`);
    expect(settings.silent_redirect_uri).toBe(`${window.location.origin}/app/auth/silent-callback`);
    expect(settings.automaticSilentRenew).toBe(true);
    expect(WebStorageStateStoreMock).toHaveBeenCalledWith({
      store: window.localStorage,
    });
  });

  it("falls back to sessionStorage when localStorage access throws", async () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo/");
    const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new DOMException("localStorage unavailable", "SecurityError");
      },
    });

    try {
      const { getKeycloakUserManagerSettings } = await import("./keycloakConfig");
      const settings = getKeycloakUserManagerSettings();
      expect(WebStorageStateStoreMock).toHaveBeenCalledWith({
        store: window.sessionStorage,
      });
      expect(settings.userStore).toEqual({ store: window.sessionStorage });
    } finally {
      if (localStorageDescriptor) {
        Object.defineProperty(window, "localStorage", localStorageDescriptor);
      }
    }
  });

  it("prefers runtime issuer and client id over env", async () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://env.example.com/realms/nemo");
    vi.stubEnv("VITE_KEYCLOAK_CLIENT_ID", "env-client");
    window.__RUNTIME_CONFIG__ = {
      keycloakIssuer: "https://runtime.example.com/realms/nemo/",
      keycloakClientId: "runtime-client",
    };

    const { getKeycloakUserManagerSettings } = await import("./keycloakConfig");
    const settings = getKeycloakUserManagerSettings();

    expect(settings.authority).toBe("https://runtime.example.com/realms/nemo");
    expect(settings.client_id).toBe("runtime-client");
  });

  it("falls back to env when runtime issuer and client id are empty", async () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://env.example.com/realms/nemo");
    vi.stubEnv("VITE_KEYCLOAK_CLIENT_ID", "env-client");
    window.__RUNTIME_CONFIG__ = {
      keycloakIssuer: "",
      keycloakClientId: " ",
    };

    const { getKeycloakUserManagerSettings } = await import("./keycloakConfig");
    const settings = getKeycloakUserManagerSettings();

    expect(settings.authority).toBe("https://env.example.com/realms/nemo");
    expect(settings.client_id).toBe("env-client");
  });

  it("sets post logout redirect to logout callback in user manager settings", async () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");

    const { getKeycloakUserManagerSettings } = await import("./keycloakConfig");
    const settings = getKeycloakUserManagerSettings();

    expect(settings.redirect_uri).toBe(`${window.location.origin}/auth/callback`);
    expect(settings.post_logout_redirect_uri).toBe(
      `${window.location.origin}/auth/logout-callback`,
    );
  });

  it("uses VITE_KEYCLOAK_POST_LOGOUT_REDIRECT_URI when set", async () => {
    vi.stubEnv("VITE_KEYCLOAK_POST_LOGOUT_REDIRECT_URI", "http://localhost:5175/auth/callback");

    const { resolvePostLogoutRedirectUri } = await import("./keycloakConfig");
    expect(resolvePostLogoutRedirectUri("http://ignored.example/cb")).toBe(
      "http://localhost:5175/auth/callback",
    );
  });

  it("uses default client id when env is unset", async () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    vi.stubEnv("VITE_KEYCLOAK_CLIENT_ID", "");

    const { getKeycloakUserManagerSettings } = await import("./keycloakConfig");
    expect(getKeycloakUserManagerSettings().client_id).toBe("agentstudio-gui");
  });

  it("throws when issuer env is missing", async () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "");
    const { getKeycloakUserManagerSettings } = await import("./keycloakConfig");
    expect(() => getKeycloakUserManagerSettings()).toThrow("Keycloak issuer is required");
  });

  it("reuses a singleton UserManager instance", async () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");

    const { getUserManager } = await import("./keycloakConfig");
    const first = getUserManager();
    const second = getUserManager();

    expect(first).toBe(second);
    expect(UserManagerMock).toHaveBeenCalledTimes(1);
  });
});
