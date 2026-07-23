import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

import { resolveAccessToken, setRuntimeAccessToken } from "./auth-access-token";

describe("resolveAccessToken", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ACCESS_TOKEN", undefined);
  });

  afterEach(() => {
    setRuntimeAccessToken(null);
    vi.unstubAllEnvs();
  });

  it("[tag:auth-access-token] prefers runtime token over env fallback", () => {
    setRuntimeAccessToken("runtime-token");

    expect(resolveAccessToken()).toBe("runtime-token");
  });

  it("[tag:auth-access-token] clears runtime token when set to null", () => {
    setRuntimeAccessToken("runtime-token");
    setRuntimeAccessToken(null);

    expect(resolveAccessToken()).toBeNull();
  });
});
