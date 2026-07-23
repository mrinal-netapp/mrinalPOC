import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { setRuntimeAccessToken } from "@/api/auth-access-token";
import { resolveDevAuthIdentity } from "./resolveDevAuthIdentity";

vi.mock("@/utils/accessTokenClaims", () => ({
  parseAccessTokenClaims: (token: string | null) => (
    token === "jwt-token"
      ? { userId: "kc-user-uuid", email: "user@example.com", roles: [], permissions: [] }
      : null
  ),
}));

describe("resolveDevAuthIdentity", () => {
  beforeEach(() => {
    setRuntimeAccessToken(null);
  });

  afterEach(() => {
    setRuntimeAccessToken(null);
    delete (import.meta.env as Record<string, unknown>).VITE_USER_ID;
  });

  it("[tag:dev-auth-identity] prefers JWT sub over VITE_USER_ID fallback", () => {
    setRuntimeAccessToken("jwt-token");
    expect(resolveDevAuthIdentity()).toEqual({
      id: "kc-user-uuid",
      email: "user@example.com",
    });
  });

  it("[tag:dev-auth-identity] falls back to VITE_USER_ID when token has no sub", async () => {
    vi.resetModules();
    (import.meta.env as Record<string, unknown>).VITE_USER_ID = "dev-user-id";
    const { resolveDevAuthIdentity: resolve } = await import("./resolveDevAuthIdentity");
    expect(resolve()).toEqual({ id: "dev-user-id" });
  });
});
