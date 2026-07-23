import { describe, expect, it } from "vitest";

import { STUB_MEMBER_ROWS, shouldUseStubMembers } from "./administration-members.stub";
import { computeMemberRoleSummary } from "./administration-members.utils";

describe("administration-members.stub", () => {
  it("[tag:administration-members] exposes mockup-like sample rows", () => {
    expect(STUB_MEMBER_ROWS.length).toBeGreaterThanOrEqual(10);
    expect(STUB_MEMBER_ROWS.some((row) => row.displayRole === "Viewer")).toBe(true);
    expect(STUB_MEMBER_ROWS.some((row) => row.lastActive.kind === "never")).toBe(true);
  });

  it("[tag:administration-members] enables stub preview on dev 401 responses", () => {
    expect(shouldUseStubMembers(true, { status: 401 })).toBe(import.meta.env.DEV);
    expect(shouldUseStubMembers(true, { status: 500 })).toBe(false);
    expect(shouldUseStubMembers(false, { status: 401 })).toBe(false);
  });

  it("[tag:administration-members] summary cards count viewer roles from stub rows", () => {
    expect(computeMemberRoleSummary(STUB_MEMBER_ROWS)).toEqual({
      total: STUB_MEMBER_ROWS.length,
      admins: STUB_MEMBER_ROWS.filter((row) => row.displayRole === "Admin").length,
      members: STUB_MEMBER_ROWS.filter((row) => row.displayRole === "Member").length,
      viewers: STUB_MEMBER_ROWS.filter((row) => row.displayRole === "Viewer").length,
    });
  });
});
