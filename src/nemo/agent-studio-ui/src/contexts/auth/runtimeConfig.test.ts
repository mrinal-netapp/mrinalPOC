import { afterEach, describe, expect, it } from "vitest";

import { getRuntimeAuthConfig } from "./runtimeConfig";

describe("getRuntimeAuthConfig", () => {
  afterEach(() => {
    delete window.__RUNTIME_CONFIG__;
  });

  it("returns undefined values when runtime config is absent", () => {
    expect(getRuntimeAuthConfig()).toEqual({
      authEnabled: undefined,
      keycloakIssuer: undefined,
      keycloakClientId: undefined,
    });
  });

  it("returns non-empty runtime config values", () => {
    window.__RUNTIME_CONFIG__ = {
      authEnabled: "true",
      keycloakIssuer: "https://auth.example.com/realms/nemo",
      keycloakClientId: "agentstudio-gui",
    };

    expect(getRuntimeAuthConfig()).toEqual({
      authEnabled: "true",
      keycloakIssuer: "https://auth.example.com/realms/nemo",
      keycloakClientId: "agentstudio-gui",
    });
  });

  it("normalizes empty and whitespace runtime config values to undefined", () => {
    window.__RUNTIME_CONFIG__ = {
      authEnabled: "",
      keycloakIssuer: "  ",
      keycloakClientId: "\t",
    };

    expect(getRuntimeAuthConfig()).toEqual({
      authEnabled: undefined,
      keycloakIssuer: undefined,
      keycloakClientId: undefined,
    });
  });
});
