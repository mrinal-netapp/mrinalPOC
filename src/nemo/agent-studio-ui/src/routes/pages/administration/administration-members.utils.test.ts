import { describe, expect, it } from "vitest";

import type { ProjectMember } from "@/api/project.types";
import {
  accessRoleFromDisplayRole,
  computeMemberRoleSummary,
  createMemberRowFromFormValues,
  deriveMemberName,
  displayRoleFromAccessRole,
  filterMemberRows,
  formatLastActiveFromTimestamp,
  isEmailAddress,
  mapProjectMembersToTableRows,
} from "./administration-members.utils";

const MEMBERS: ProjectMember[] = [
  {
    userId: "al@example.com",
    role: "admin",
  },
  {
    userId: "ben@example.com",
    role: "member",
  },
];

describe("administration-members.utils", () => {
  it("[tag:administration-members] derives display name from user id", () => {
    expect(deriveMemberName("al@example.com")).toBe("Al");
    expect(deriveMemberName("user-123", "Al Smith")).toBe("Al Smith");
  });

  it("[tag:administration-members] maps members to table rows and summary counts", () => {
    const rows = mapProjectMembersToTableRows(MEMBERS);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.displayRole).toBe("Admin");
    expect(computeMemberRoleSummary(rows)).toEqual({
      total: 2,
      admins: 1,
      members: 1,
      viewers: 0,
    });
  });

  it("[tag:administration-members] filters rows by search term", () => {
    const rows = mapProjectMembersToTableRows(MEMBERS);
    expect(filterMemberRows(rows, "ben")).toHaveLength(1);
    expect(filterMemberRows(rows, "")).toHaveLength(2);
  });

  it("[tag:administration-members] formats last active labels", () => {
    expect(formatLastActiveFromTimestamp(undefined)).toEqual({ kind: "never" });
    expect(formatLastActiveFromTimestamp("invalid")).toEqual({ kind: "never" });
    expect(formatLastActiveFromTimestamp(new Date().toISOString()).kind).toBe("relative");
  });

  it("[tag:administration-members] validates email addresses", () => {
    expect(isEmailAddress("user@example.com")).toBe(true);
    expect(isEmailAddress("not-an-email")).toBe(false);
  });

  it("[tag:administration-members] maps display roles to access roles", () => {
    expect(accessRoleFromDisplayRole("Admin")).toBe("admin");
    expect(accessRoleFromDisplayRole("Viewer")).toBe("viewer");
    expect(accessRoleFromDisplayRole("Member")).toBe("member");
    expect(displayRoleFromAccessRole("admin")).toBe("Admin");
    expect(displayRoleFromAccessRole("viewer")).toBe("Viewer");
    expect(displayRoleFromAccessRole("member")).toBe("Member");
  });

  it("[tag:administration-members] creates table rows from form values", () => {
    const row = createMemberRowFromFormValues({
      name: "Carol Jones",
      email: "carol@example.com",
      role: "admin",
    });

    expect(row).toMatchObject({
      name: "Carol Jones",
      email: "carol@example.com",
      role: "admin",
      displayRole: "Admin",
    });
    expect(row.lastActive).toEqual({ kind: "relative", label: "Today" });
  });

  it("[tag:administration-members] counts viewer roles in summary", () => {
    const rows = mapProjectMembersToTableRows([
      { userId: "viewer@example.com", role: "viewer" },
    ]);

    expect(computeMemberRoleSummary(rows)).toEqual({
      total: 1,
      admins: 0,
      members: 0,
      viewers: 1,
    });
  });
});
