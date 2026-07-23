import { describe, expect, it } from "vitest";

import {
  PLATFORM_ADMIN_ROLE,
  PLATFORM_MEMBER_ROLE,
  PLATFORM_ROLES,
  hasPlatformAccess,
} from "./platformAccess";

describe("platformAccess", () => {
  it("exports platform role constants", () => {
    expect(PLATFORM_ROLES).toEqual([PLATFORM_ADMIN_ROLE, PLATFORM_MEMBER_ROLE]);
  });

  it("allows platform-admin and platform-member", () => {
    expect(hasPlatformAccess(["platform-admin"])).toBe(true);
    expect(hasPlatformAccess(["platform-member"])).toBe(true);
    expect(hasPlatformAccess(["other"])).toBe(false);
    expect(hasPlatformAccess([])).toBe(false);
  });
});
