import type { ProjectMember, ProjectMemberRole } from "@/api/project.types";
import { formatProjectMemberRole } from "@/api/project.types";
import type { AccessUserRole } from "@/routes/pages/projects/create-edit/project-access.consts";
import { toApiMemberRole } from "@/routes/pages/projects/create-edit/project-access.consts";

export interface MemberListTableRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: ProjectMemberRole;
  displayRole: string;
  lastActive: MemberLastActiveDisplay;
  createdAt: string;
}

export type MemberLastActiveDisplay =
  | { kind: "never" }
  | { kind: "relative"; label: string };

export interface MemberRoleSummary {
  total: number;
  admins: number;
  members: number;
  viewers: number;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailAddress(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export function deriveMemberName(userId: string, explicitName?: string): string {
  const trimmedName = explicitName?.trim();
  if (trimmedName) return trimmedName;

  const trimmedUserId = userId.trim();
  if (isEmailAddress(trimmedUserId)) {
    const localPart = trimmedUserId.split("@")[0] ?? trimmedUserId;
    return localPart
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  }

  return trimmedUserId;
}

export function formatLastActiveFromTimestamp(timestamp?: string): MemberLastActiveDisplay {
  if (!timestamp) {
    return { kind: "never" };
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return { kind: "never" };
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round(
    (startOfToday.getTime() - startOfTarget.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (dayDiff <= 0) {
    return { kind: "relative", label: "Today" };
  }

  if (dayDiff === 1) {
    return { kind: "relative", label: "1 day ago" };
  }

  return { kind: "relative", label: `${dayDiff} days ago` };
}

export function computeMemberRoleSummary(rows: MemberListTableRow[]): MemberRoleSummary {
  return rows.reduce<MemberRoleSummary>(
    (summary, row) => {
      summary.total += 1;

      if (row.role === "admin") {
        summary.admins += 1;
      } else if (row.role === "viewer") {
        summary.viewers += 1;
      } else {
        summary.members += 1;
      }

      return summary;
    },
    { total: 0, admins: 0, members: 0, viewers: 0 },
  );
}

export function mapProjectMembersToTableRows(
  members: ProjectMember[],
): MemberListTableRow[] {
  return members.map((member) => ({
    id: member.userId,
    userId: member.userId,
    name: deriveMemberName(member.userId, member.username),
    email: member.email ?? "",
    role: member.role,
    displayRole: formatProjectMemberRole(member.role),
    lastActive: { kind: "never" as const },
    createdAt: "",
  }));
}

export function filterMemberRows(
  rows: MemberListTableRow[],
  searchTerm: string,
): MemberListTableRow[] {
  const term = searchTerm.trim().toLowerCase();
  if (!term) return rows;

  return rows.filter((row) =>
    [row.name, row.email, row.displayRole, row.userId]
      .some((value) => value.toLowerCase().includes(term)),
  );
}

export function accessRoleFromDisplayRole(displayRole: string): AccessUserRole {
  const normalized = displayRole.toLowerCase();
  if (normalized === "admin") return "admin";
  if (normalized === "viewer") return "viewer";
  return "member";
}

export function displayRoleFromAccessRole(role: AccessUserRole): string {
  if (role === "admin") return "Admin";
  if (role === "viewer") return "Viewer";
  return "Member";
}

export function createMemberRowFromFormValues(
  values: { name: string; email: string; role: AccessUserRole },
): MemberListTableRow {
  const email = values.email.trim();
  return {
    id: email,
    userId: email,
    name: values.name.trim(),
    email,
    role: toApiMemberRole(values.role),
    displayRole: displayRoleFromAccessRole(values.role),
    lastActive: { kind: "relative", label: "Today" },
    createdAt: new Date().toISOString(),
  };
}
