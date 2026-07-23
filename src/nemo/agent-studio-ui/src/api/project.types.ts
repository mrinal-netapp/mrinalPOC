export interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  home_dir: string;
  /**
   * Caller's role on this project, populated by `GET /api/v1/projects`
   * (caller-scoped). Optional because legacy non-caller-scoped responses
   * and older config-service builds may omit it.
   */
  role?: ProjectMemberRole;
}

export interface ProjectListResponse {
  projects: Project[];
}

export interface CreateProjectRequest {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateProjectRequest {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectErrorResponse {
  error: string;
  code: string;
}

export const PROJECT_MEMBER_ROLES = ["admin", "member", "viewer"] as const;

export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

export interface ProjectMember {
  userId: string;
  role: ProjectMemberRole;
  email?: string;
  username?: string;
}

export interface ProjectMemberListResponse {
  projectId: string;
  members: ProjectMember[];
}

export interface UserProjectEntry {
  projectId: string;
  role: ProjectMemberRole;
}

export interface UserProjectsResponse {
  userId: string;
  projects: UserProjectEntry[];
}

export interface AddProjectMemberRequest {
  email: string;
  role: ProjectMemberRole;
}

export interface RemoveProjectMemberRequest {
  email: string;
}

export interface UpdateProjectMemberRoleRequest {
  email: string;
  role: ProjectMemberRole;
}

export interface ProjectMembershipWorkflowResponse {
  workflowId: string;
  status: string;
  projectId: string;
  email: string;
  role?: ProjectMemberRole;
  /** Add-member response only: true if Keycloak provisioned a new user for this email. */
  created?: boolean;
}

/** Mockup "Description" maps to this metadata key (API has no top-level description field). */
export const PROJECT_METADATA_DESCRIPTION_KEY = "description";

export function getProjectDescription(metadata?: Record<string, unknown>): string {
  if (!metadata) return "";
  const value = metadata[PROJECT_METADATA_DESCRIPTION_KEY];
  return typeof value === "string" ? value : "";
}

export function formatProjectMemberRole(role: ProjectMemberRole | undefined): string {
  if (!role) return "—";
  if (role === "admin") return "Admin";
  if (role === "viewer") return "Viewer";
  return "Member";
}

export function formatProjectMemberCount(count: number): string {
  return count === 1 ? "1 user" : `${count} users`;
}

function isProjectMemberRole(value: unknown): value is ProjectMemberRole {
  return value === "admin" || value === "member" || value === "viewer";
}

/** Accept camelCase or legacy snake_case membership payloads from the gateway. */
export function normalizeProjectMember(raw: Record<string, unknown>): ProjectMember | null {
  const userId = raw.userId ?? raw.user_id;
  const role = raw.role;
  if (typeof userId !== "string" || !userId.trim() || !isProjectMemberRole(role)) {
    return null;
  }

  const email = typeof raw.email === "string" ? raw.email : undefined;
  const username = typeof raw.username === "string" ? raw.username : undefined;

  return { userId: userId.trim(), role, email, username };
}

export function normalizeProjectMemberListResponse(
  raw: Record<string, unknown>,
): ProjectMemberListResponse {
  const projectId = String(raw.projectId ?? raw.project_id ?? "");
  const membersRaw = Array.isArray(raw.members) ? raw.members : [];
  const members = membersRaw
    .map((entry) => normalizeProjectMember(entry as Record<string, unknown>))
    .filter((entry): entry is ProjectMember => entry != null);

  return { projectId, members };
}

export function normalizeUserProjectsResponse(
  raw: Record<string, unknown>,
): UserProjectsResponse {
  const userId = String(raw.userId ?? raw.user_id ?? "");
  const projectsRaw = Array.isArray(raw.projects) ? raw.projects : [];
  const projects = projectsRaw.flatMap((entry) => {
    const record = entry as Record<string, unknown>;
    const projectId = record.projectId ?? record.project_id;
    const role = record.role;
    if (typeof projectId !== "string" || !projectId.trim() || !isProjectMemberRole(role)) {
      return [];
    }
    return [{ projectId: projectId.trim(), role }];
  });

  return { userId, projects };
}
