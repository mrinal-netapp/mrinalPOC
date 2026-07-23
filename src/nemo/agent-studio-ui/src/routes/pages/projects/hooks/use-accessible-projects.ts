import { useMemo } from "react";

import { useListProjectsQuery } from "@/api/project-api.slice";
import type { Project, ProjectMemberRole } from "@/api/project.types";
import { formatProjectMemberRole } from "@/api/project.types";
import { useAuth } from "@/contexts/auth";

export type AccessibleProject = Project & {
  membershipRole: ProjectMemberRole;
  roleLabel: string;
  isAdmin: boolean;
};

/**
 * Project list with the caller's role on each entry.
 *
 * Backed by a single call to `GET /api/v1/projects`, which is
 * caller-scoped (Keycloak Authz policies) and now carries `role` inline
 * on every project. The previous two-call form (this hook + a separate
 * `GET /users/{id}/projects`) was needed when `/projects` returned the
 * full cluster-wide list; that join is now redundant.
 */
function useAccessibleProjects(): {
  projects: AccessibleProject[];
  roleByProjectId: Record<string, ProjectMemberRole>;
  isProjectAdmin: (projectId: string) => boolean;
  isLoading: boolean;
  isError: boolean;
} {
  const { user, loading: authLoading } = useAuth();

  const {
    data: allProjectsData,
    isLoading: isLoadingProjects,
    isError: isProjectsError,
  } = useListProjectsQuery(undefined, {
    skip: authLoading || !user?.id,
  });

  return useMemo(() => {
    const projectsWithRole = (allProjectsData?.projects ?? []).filter(
      (p): p is Project & { role: ProjectMemberRole } => p.role != null,
    );

    const roleByProjectId = Object.fromEntries(
      projectsWithRole.map((p) => [p.id, p.role]),
    ) as Record<string, ProjectMemberRole>;

    const projects: AccessibleProject[] = projectsWithRole.map((project) => ({
      ...project,
      membershipRole: project.role,
      roleLabel: formatProjectMemberRole(project.role),
      isAdmin: project.role === "admin",
    }));

    return {
      projects,
      roleByProjectId,
      isProjectAdmin: (projectId: string) => roleByProjectId[projectId] === "admin",
      isLoading: authLoading || isLoadingProjects,
      isError: isProjectsError,
    };
  }, [allProjectsData?.projects, authLoading, isLoadingProjects, isProjectsError]);
}

export { useAccessibleProjects };
