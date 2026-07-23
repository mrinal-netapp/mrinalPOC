import { describe, expect, it } from "vitest";

import { getDisplayNameFromAccessToken, getUserIdFromAccessToken, parseAccessTokenClaims } from "./accessTokenClaims";

function createAccessToken(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${body}.sig`;
}

describe("parseAccessTokenClaims", () => {
  it("returns null for malformed tokens", () => {
    expect(parseAccessTokenClaims("not-a-jwt")).toBeNull();
    expect(parseAccessTokenClaims("only.one")).toBeNull();
    expect(parseAccessTokenClaims("a.!!!invalid!!!.c")).toBeNull();
  });

  it("returns null when sub is missing or empty", () => {
    expect(parseAccessTokenClaims(createAccessToken({ realm_access: { roles: ["platform-admin"] } }))).toBeNull();
    expect(parseAccessTokenClaims(createAccessToken({ sub: "" }))).toBeNull();
  });

  it("maps platform-admin roles and permissions", () => {
    const token = createAccessToken({
      sub: "user-1",
      email: "user@example.com",
      realm_access: { roles: ["platform-admin", "offline_access"] },
    });

    expect(parseAccessTokenClaims(token)).toEqual({
      userId: "user-1",
      name: "user@example.com",
      email: "user@example.com",
      roles: ["platform-admin", "offline_access"],
      permissions: ["admin:manage", "data:read"],
    });
  });

  it("maps platform-member roles and permissions", () => {
    const token = createAccessToken({
      sub: "user-2",
      realm_access: { roles: ["platform-member"] },
    });

    expect(parseAccessTokenClaims(token)).toEqual({
      userId: "user-2",
      name: "user-2",
      email: undefined,
      roles: ["platform-member"],
      permissions: ["data:read"],
    });
  });

  it("merges realm and agent-studio-api client roles", () => {
    const token = createAccessToken({
      sub: "user-3",
      realm_access: { roles: ["platform-member"] },
      resource_access: {
        "agent-studio-api": { roles: ["custom-role"] },
      },
    });

    const claims = parseAccessTokenClaims(token);
    expect(claims?.roles).toEqual(["platform-member", "custom-role"]);
    expect(claims?.permissions).toEqual(["data:read"]);
  });

  it("returns empty permissions when no platform roles match", () => {
    const token = createAccessToken({
      sub: "user-4",
      realm_access: { roles: ["other-role"] },
    });

    expect(parseAccessTokenClaims(token)?.permissions).toEqual([]);
  });
});

describe("getUserIdFromAccessToken", () => {
  it("returns sub or null", () => {
    const token = createAccessToken({ sub: "user-1", realm_access: { roles: ["platform-admin"] } });

    expect(getUserIdFromAccessToken(null)).toBeNull();
    expect(getUserIdFromAccessToken(token)).toBe("user-1");
  });
});

describe("getDisplayNameFromAccessToken", () => {
  it("returns the best available display claim", () => {
    expect(getDisplayNameFromAccessToken(null)).toBeNull();
    expect(getDisplayNameFromAccessToken(createAccessToken({ sub: "user-1", name: "Ada Lovelace" }))).toBe("Ada Lovelace");
    expect(getDisplayNameFromAccessToken(createAccessToken({ sub: "user-2", preferred_username: "ada" }))).toBe("ada");
    expect(getDisplayNameFromAccessToken(createAccessToken({ sub: "user-3", email: "ada@example.com" }))).toBe("ada@example.com");
    expect(getDisplayNameFromAccessToken(createAccessToken({ sub: "user-4" }))).toBe("user-4");
  });
});
