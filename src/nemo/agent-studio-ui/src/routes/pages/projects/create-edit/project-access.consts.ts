import type { ProjectMemberRole } from "@/api/project.types";

export type PendingProjectMemberInvite = {
  email: string;
  role: ProjectMemberRole;
};

export type AccessInviteMode = "now" | "later";

export type AccessUserRole = ProjectMemberRole | "viewer";

export type AccessUserRow = {
  localId: string;
  userId: string;
  email: string;
  role: AccessUserRole;
};

export const PROJECT_ACCESS_STRINGS = {
  INTRO:
    "Invite your team to collaborate on this project. You can also do this later from project management settings.",
  INVITE_NOW_LABEL: "Invite users",
  INVITE_NOW_DESCRIPTION: "Add teammates to this project so they can access it right away.",
  INVITE_LATER_LABEL: "Invite users later",
  INVITE_LATER_DESCRIPTION: "You can invite users later from project management settings.",
  INVITE_LATER_INFO: "You can update access and invite team members in project settings.",
  ROLE_PERMISSIONS_HINT:
    "Select Add user to invite additional users. Admins have full access. Members can create and edit. Viewers have read-only access.",
  ROLE_LABEL: "Role",
  EMAIL_ADDRESS_LABEL: "Email address",
  EMAIL_ADDRESS_PLACEHOLDER: "Enter email address or user ID",
  EMAIL_ADDRESS_TOOLTIP: "Enter the user's email address. Keycloak user IDs are also accepted.",
  ADD_USER_LABEL: "Add user",
  ACTION_NEEDED: "Action needed",
  LOADING_MEMBERS: "Loading members…",
  LOAD_MEMBERS_ERROR: "Failed to load project members. Please try again.",
  MEMBERS_SAVE_ERROR: "Project saved, but some member changes could not be applied.",
  INVITE_SUCCESS: (userId: string) => `User "${userId}" invited successfully.`,
  INVITE_ERROR: "Failed to invite user. Please try again.",
  INVITE_INIT_TIMEOUT:
    "Project created, but member invites could not be applied because project initialization is still in progress. Add members from project settings once initialization completes.",
  REMOVE_SUCCESS: (userId: string) => `User "${userId}" removed successfully.`,
  REMOVE_ERROR: "Failed to remove user. Please try again.",
  ROLE_UPDATE_SUCCESS: "Member role updated successfully.",
  ROLE_UPDATE_ERROR: "Failed to update member role. Please try again.",
  EMAIL_REQUIRED: "Email address is required",
  DUPLICATE_USER: "This user is already in the list.",
  NO_MEMBERS: "No members yet. Invite users to grant access.",
  USERS_HEADING: (count: number) => `Users (${count})`,
  REMOVE_USER_ARIA_LABEL: "Remove user",
} as const;

export const PROJECT_MEMBER_ROLE_OPTIONS = [
  { key: "viewer", value: "viewer", label: "Viewer" },
  { key: "member", value: "member", label: "Member" },
  { key: "admin", value: "admin", label: "Admin" },
] as const;

export function toApiMemberRole(role: AccessUserRole): ProjectMemberRole {
  return role;
}

function createLocalRowId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `row-${Math.random().toString(36).slice(2)}`;
}

export type AccessMemberChanges = {
  invites: PendingProjectMemberInvite[];
  removedEmails: string[];
  roleUpdates: Array<{ email: string; role: ProjectMemberRole }>;
};

export const EMPTY_ACCESS_MEMBER_CHANGES: AccessMemberChanges = {
  invites: [],
  removedEmails: [],
  roleUpdates: [],
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Diff existing project members against the edited rows. Identity is now
 * by email (the server resolves email → userId). The diff returns:
 *   - invites: rows with an email not present in the initial set
 *   - removedEmails: initial emails missing from the rows
 *   - roleUpdates: rows whose role changed since load
 */
export function computeAccessMemberChanges(
  initialEmails: string[],
  initialRolesByEmail: Record<string, ProjectMemberRole>,
  rows: AccessUserRow[],
): AccessMemberChanges {
  const normalizedInitial = initialEmails.map(normalizeEmail);
  const rowEmails = new Set(
    rows
      .map((row) => normalizeEmail(row.email))
      .filter((email) => email !== ""),
  );

  const removedEmails = normalizedInitial.filter((email) => !rowEmails.has(email));
  const invites: PendingProjectMemberInvite[] = [];
  const roleUpdates: Array<{ email: string; role: ProjectMemberRole }> = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const email = normalizeEmail(row.email);
    if (email === "" || seen.has(email)) continue;
    seen.add(email);

    const apiRole = toApiMemberRole(row.role);
    const initialRole = initialRolesByEmail[email];

    if (initialRole == null) {
      invites.push({ email, role: apiRole });
      continue;
    }

    if (initialRole !== apiRole) {
      roleUpdates.push({ email, role: apiRole });
    }
  }

  return { invites, removedEmails, roleUpdates };
}

export function createAccessUserRow(
  partial: Partial<AccessUserRow> = {},
): AccessUserRow {
  return {
    localId: partial.localId ?? createLocalRowId(),
    userId: partial.userId ?? "",
    role: partial.role ?? "viewer",
    email: partial.email ?? "",
  };
}
