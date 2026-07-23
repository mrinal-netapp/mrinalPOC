import { describe, expect, it } from "vitest";

import {
  formatProjectMemberCount,
  formatProjectMemberRole,
  normalizeProjectMemberListResponse,
  normalizeUserProjectsResponse,
} from "./project.types";

describe("formatProjectMemberRole", () => {
  it("[tag:project-members] formats admin, member, and viewer roles", () => {
    expect(formatProjectMemberRole("admin")).toBe("Admin");
    expect(formatProjectMemberRole("member")).toBe("Member");
    expect(formatProjectMemberRole("viewer")).toBe("Viewer");
    expect(formatProjectMemberRole(undefined)).toBe("—");
  });
});

describe("formatProjectMemberCount", () => {
  it("[tag:project-members] formats member count label", () => {
    expect(formatProjectMemberCount(0)).toBe("0 users");
    expect(formatProjectMemberCount(1)).toBe("1 user");
    expect(formatProjectMemberCount(2)).toBe("2 users");
  });
});

describe("membership response normalization", () => {
  it("[tag:project-members] normalizes snake_case member list responses", () => {
    expect(
      normalizeProjectMemberListResponse({
        project_id: "proj-1",
        members: [{ user_id: "user-1", role: "admin" }],
      }),
    ).toEqual({
      projectId: "proj-1",
      members: [{ userId: "user-1", role: "admin" }],
    });
  });

  it("[tag:project-members] normalizes snake_case user projects responses", () => {
    expect(
      normalizeUserProjectsResponse({
        user_id: "user-1",
        projects: [{ project_id: "proj-1", role: "viewer" }],
      }),
    ).toEqual({
      userId: "user-1",
      projects: [{ projectId: "proj-1", role: "viewer" }],
    });
  });
});
