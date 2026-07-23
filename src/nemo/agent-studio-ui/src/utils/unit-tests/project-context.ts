import type { ProjectMemberRole } from "@/api/project.types";
import type { ActiveProject } from "@/store/store.types";
import type { ProjectContextValue } from "@/contexts/project/model/project.types";

function rolesEqual(a: string | null | undefined, b: string): boolean {
  return a != null && a.trim().toLowerCase() === b;
}

/**
 * Builds a stub `ProjectContextValue` for tests. Mirrors the production
 * ProjectProvider's value shape but skips the real Auth + RTK Query
 * wiring (which tests rarely need to exercise via the provider). Pulls
 * the active-project tuple from `preloadedState.projectContext.activeProject`
 * when present, then lets a test override any field via `overrides`.
 */
export function buildTestProjectContextValue(
  active: ActiveProject | undefined,
  overrides?: Partial<ProjectContextValue>,
): ProjectContextValue {
  const hasActiveProject = Boolean(active?.id && active?.role);
  const activeProject = hasActiveProject
    ? { id: active!.id, name: active!.name, role: active!.role as ProjectMemberRole }
    : null;
  const role = activeProject?.role ?? null;

  const defaults: ProjectContextValue = {
    activeProject,
    accessibleProjects: [],
    hasActiveProject,
    isAdmin: rolesEqual(role, "admin"),
    isMember: rolesEqual(role, "member"),
    isViewer: rolesEqual(role, "viewer"),
    hasAnyRole: (requiredRoles: readonly string[]) =>
      role != null
      && requiredRoles.some((r) => r.trim().toLowerCase() === role),
    loading: false,
    error: null,
    switchProject: () => {},
    clearProject: () => {},
  };

  return { ...defaults, ...overrides };
}
