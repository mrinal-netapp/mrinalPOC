import type { ProjectMemberRole } from "@/api/project.types";

import { useProject } from "./useProject";

type UseProjectRoleResult = {
  role: ProjectMemberRole | null;
  isAdmin: boolean;
  isMember: boolean;
  isViewer: boolean;
  hasAnyRole: (requiredRoles: readonly string[]) => boolean;
};

/** Convenience over `useProject()` for role-only consumers. */
function useProjectRole(): UseProjectRoleResult {
  const { activeProject, isAdmin, isMember, isViewer, hasAnyRole } = useProject();
  return {
    role: activeProject?.role ?? null,
    isAdmin,
    isMember,
    isViewer,
    hasAnyRole,
  };
}

export { useProjectRole };
