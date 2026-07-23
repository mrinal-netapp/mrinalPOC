import { describe, expect, it } from "vitest";

import { hasAnyRole, isProjectAccessAllowed, rolesEqual } from "./projectAccess";

describe("projectAccess", () => {
  describe("rolesEqual", () => {
    it("[tag:project-access] matches roles case-insensitively and ignores whitespace", () => {
      expect(rolesEqual(" Admin ", "admin")).toBe(true);
      expect(rolesEqual("member", "Member")).toBe(true);
    });

    it("[tag:project-access] returns false when either role is empty or null", () => {
      expect(rolesEqual(null, "admin")).toBe(false);
      expect(rolesEqual("admin", null)).toBe(false);
      expect(rolesEqual("   ", "admin")).toBe(false);
      expect(rolesEqual("admin", "")).toBe(false);
    });
  });

  describe("hasAnyRole", () => {
    it("[tag:project-access] returns true when user role matches any required role", () => {
      expect(hasAnyRole("admin", ["member", "admin"])).toBe(true);
      expect(hasAnyRole("Viewer", ["viewer"])).toBe(true);
    });

    it("[tag:project-access] returns false when user role is missing or unmatched", () => {
      expect(hasAnyRole(null, ["admin"])).toBe(false);
      expect(hasAnyRole("member", ["admin"])).toBe(false);
      expect(hasAnyRole("   ", ["admin"])).toBe(false);
    });
  });

  describe("isProjectAccessAllowed", () => {
    it("[tag:project-access] allows access when requireProject is false and no roles are required", () => {
      expect(isProjectAccessAllowed({
        requireProject: false,
        hasActiveProject: false,
        userRoles: [],
      })).toBe(true);
    });

    it("[tag:project-access] still enforces requiredRoles when requireProject is false", () => {
      // Regression: a platform-level item (Administration / super-admin
      // views) is `requireProject: false` to allow rendering without a
      // selected project — but it must STILL gate on roles. Previously
      // the role check was short-circuited away when requireProject was
      // false, letting any signed-in user see role-gated platform pages.
      expect(isProjectAccessAllowed({
        requireProject: false,
        hasActiveProject: false,
        requiredRoles: ["super-admin"],
        userRoles: ["member"],
      })).toBe(false);

      expect(isProjectAccessAllowed({
        requireProject: false,
        hasActiveProject: false,
        requiredRoles: ["super-admin"],
        userRoles: ["super-admin"],
      })).toBe(true);
    });

    it("[tag:project-access] blocks access when project is required but missing", () => {
      expect(isProjectAccessAllowed({
        requireProject: true,
        hasActiveProject: false,
        userRoles: ["admin"],
      })).toBe(false);
    });

    it("[tag:project-access] allows any active project member when no roles are required", () => {
      expect(isProjectAccessAllowed({
        requireProject: true,
        hasActiveProject: true,
        requiredRoles: [],
        userRoles: ["viewer"],
      })).toBe(true);

      expect(isProjectAccessAllowed({
        requireProject: true,
        hasActiveProject: true,
        requiredRoles: undefined,
        userRoles: ["member"],
      })).toBe(true);
    });

    it("[tag:project-access] requires a matching role when requiredRoles is set", () => {
      expect(isProjectAccessAllowed({
        requireProject: true,
        hasActiveProject: true,
        requiredRoles: ["admin"],
        userRoles: ["admin"],
      })).toBe(true);

      expect(isProjectAccessAllowed({
        requireProject: true,
        hasActiveProject: true,
        requiredRoles: ["admin"],
        userRoles: ["member"],
      })).toBe(false);
    });

    it("[tag:project-access] unions multiple role sources (project role + auth realm roles)", () => {
      // Sidebar passes `[activeProject?.role, ...authRoles]` — a user
      // who's only a `viewer` in the active project but holds the
      // platform realm role `super-admin` should still pass the
      // ["super-admin"] gate via the realm-role side.
      expect(isProjectAccessAllowed({
        requireProject: false,
        hasActiveProject: true,
        requiredRoles: ["super-admin"],
        userRoles: ["viewer", "super-admin"],
      })).toBe(true);
    });

    it("[tag:project-access] filters null/undefined/whitespace entries in userRoles", () => {
      expect(isProjectAccessAllowed({
        requireProject: false,
        hasActiveProject: false,
        requiredRoles: ["admin"],
        userRoles: [null, undefined, "   ", "admin"],
      })).toBe(true);

      expect(isProjectAccessAllowed({
        requireProject: false,
        hasActiveProject: false,
        requiredRoles: ["admin"],
        userRoles: [null, undefined, "   "],
      })).toBe(false);
    });
  });
});
