import { afterEach, describe, expect, it, vi } from "vitest";

import { isKeycloakIdpSignoutEnabled, isOidcAuthEnabled } from "./authConfig";

describe("isOidcAuthEnabled", () => {
  afterEach(() => {
    delete window.__RUNTIME_CONFIG__;
    vi.unstubAllEnvs();
  });

  it("returns false when issuer and flag are missing", () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "");
    vi.stubEnv("VITE_AUTH_ENABLED", "");
    expect(isOidcAuthEnabled()).toBe(false);
  });

  it("returns false when only issuer is set (must opt in explicitly)", () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    vi.stubEnv("VITE_AUTH_ENABLED", "");
    expect(isOidcAuthEnabled()).toBe(false);
  });

  it("returns false when VITE_AUTH_ENABLED is false", () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    vi.stubEnv("VITE_AUTH_ENABLED", "false");
    expect(isOidcAuthEnabled()).toBe(false);
  });

  it("returns false when flag is true but issuer is missing", () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "");
    vi.stubEnv("VITE_AUTH_ENABLED", "true");
    expect(isOidcAuthEnabled()).toBe(false);
  });

  it("returns false when VITE_AUTH_ENABLED is an unrecognized value", () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    vi.stubEnv("VITE_AUTH_ENABLED", "maybe");
    expect(isOidcAuthEnabled()).toBe(false);
  });

  it("returns true when VITE_AUTH_ENABLED is true and issuer is set", () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    vi.stubEnv("VITE_AUTH_ENABLED", "true");
    expect(isOidcAuthEnabled()).toBe(true);
  });

  it("returns true when VITE_AUTH_ENABLED is 1 and issuer is set", () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    vi.stubEnv("VITE_AUTH_ENABLED", "1");
    expect(isOidcAuthEnabled()).toBe(true);
  });

  it("returns false when VITE_AUTH_ENABLED is 0", () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    vi.stubEnv("VITE_AUTH_ENABLED", "0");
    expect(isOidcAuthEnabled()).toBe(false);
  });

  it("prefers non-empty runtime config over env", () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://env.example.com/realms/nemo");
    vi.stubEnv("VITE_AUTH_ENABLED", "false");
    window.__RUNTIME_CONFIG__ = {
      authEnabled: "true",
      keycloakIssuer: "https://runtime.example.com/realms/nemo",
    };

    expect(isOidcAuthEnabled()).toBe(true);
  });

  it("falls back to env when runtime config values are empty", () => {
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://env.example.com/realms/nemo");
    vi.stubEnv("VITE_AUTH_ENABLED", "true");
    window.__RUNTIME_CONFIG__ = {
      authEnabled: " ",
      keycloakIssuer: "",
    };

    expect(isOidcAuthEnabled()).toBe(true);
  });
});

describe("isKeycloakIdpSignoutEnabled", () => {
  afterEach(() => {
    delete window.__RUNTIME_CONFIG__;
    vi.unstubAllEnvs();
  });

  it("returns false when OIDC is disabled", () => {
    vi.stubEnv("VITE_AUTH_ENABLED", "false");
    vi.stubEnv("VITE_KEYCLOAK_IDP_SIGNOUT", "");
    expect(isKeycloakIdpSignoutEnabled()).toBe(false);
  });

  it("returns true by default when OIDC is enabled", () => {
    vi.stubEnv("VITE_AUTH_ENABLED", "true");
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    vi.stubEnv("VITE_KEYCLOAK_IDP_SIGNOUT", "");
    expect(isKeycloakIdpSignoutEnabled()).toBe(true);
  });

  it("returns true by default when OIDC is enabled and IDP signout is unset", () => {
    vi.stubEnv("VITE_AUTH_ENABLED", "true");
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    delete (import.meta.env as Record<string, string | undefined>).VITE_KEYCLOAK_IDP_SIGNOUT;
    expect(isKeycloakIdpSignoutEnabled()).toBe(true);
  });

  it("returns true when explicitly enabled", () => {
    vi.stubEnv("VITE_AUTH_ENABLED", "false");
    vi.stubEnv("VITE_KEYCLOAK_IDP_SIGNOUT", "true");
    expect(isKeycloakIdpSignoutEnabled()).toBe(true);
  });

  it("returns false when explicitly disabled for local Keycloak", () => {
    vi.stubEnv("VITE_AUTH_ENABLED", "true");
    vi.stubEnv("VITE_KEYCLOAK_ISSUER", "https://auth.example.com/realms/nemo");
    vi.stubEnv("VITE_KEYCLOAK_IDP_SIGNOUT", "false");
    expect(isKeycloakIdpSignoutEnabled()).toBe(false);
  });
});
