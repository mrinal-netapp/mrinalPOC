import { describe, expect, it } from "vitest";

import { isAccessAllowed } from "./authAccess";

describe("isAccessAllowed", () => {
  it("blocks unauthenticated users on protected paths", () => {
    expect(
      isAccessAllowed({
        requireAuth: true,
        isAuthenticated: false,
        userRoles: [],
        userPermissions: [],
      }),
    ).toBe(false);
  });

  it("allows authenticated users on protected paths when no role/permission constraints are set", () => {
    expect(
      isAccessAllowed({
        requireAuth: true,
        isAuthenticated: true,
        userRoles: ["user"],
        userPermissions: ["data:read"],
      }),
    ).toBe(true);
  });

  it("treats requireAuth=false as public access and skips role/permission checks", () => {
    expect(
      isAccessAllowed({
        requireAuth: false,
        isAuthenticated: false,
        userRoles: [],
        userPermissions: [],
      }),
    ).toBe(true);

    expect(
      isAccessAllowed({
        requireAuth: false,
        isAuthenticated: true,
        userRoles: ["user"],
        userPermissions: ["data:read"],
      }),
    ).toBe(true);

    expect(
      isAccessAllowed({
        requireAuth: false,
        isAuthenticated: true,
        requiredRoles: ["admin"],
        requiredPermissions: ["admin:manage"],
        userRoles: ["user"],
        userPermissions: [],
      }),
    ).toBe(true);
  });

  it("denies access when neither required role nor required permission matches", () => {
    expect(
      isAccessAllowed({
        requireAuth: true,
        isAuthenticated: true,
        requiredRoles: ["admin"],
        requiredPermissions: ["admin:manage"],
        userRoles: ["user"],
        userPermissions: ["data:read"],
      }),
    ).toBe(false);
  });

  it("allows access when required role matches even if permission does not", () => {
    expect(
      isAccessAllowed({
        requireAuth: true,
        isAuthenticated: true,
        requiredRoles: ["admin"],
        requiredPermissions: ["admin:manage"],
        userRoles: ["admin", "user"],
        userPermissions: ["data:read"],
      }),
    ).toBe(true);
  });

  it("allows access when required permission matches even if role does not", () => {
    expect(
      isAccessAllowed({
        requireAuth: true,
        isAuthenticated: true,
        requiredRoles: ["admin"],
        requiredPermissions: ["admin:manage"],
        userRoles: ["user"],
        userPermissions: ["admin:manage", "data:read"],
      }),
    ).toBe(true);
  });
});
