import { useMemo } from "react";

import { formatProjectMemberRole } from "@/api/project.types";
import { useAuth } from "@/contexts/auth";
import { useAccessibleProjects } from "./use-accessible-projects";

/** Maps project ids to formatted role labels for the signed-in user. */
function useProjectRolesMap(projectIds: string[]): Record<string, string> {
  const { user, loading: authLoading } = useAuth();
  const userId = user?.id;
  const { roleByProjectId } = useAccessibleProjects();

  return useMemo(() => {
    if (projectIds.length === 0) {
      return {};
    }

    if (authLoading || !userId) {
      return Object.fromEntries(projectIds.map((projectId) => [projectId, "—"]));
    }

    return Object.fromEntries(
      projectIds.map((projectId) => [
        projectId,
        formatProjectMemberRole(roleByProjectId[projectId]),
      ]),
    );
  }, [authLoading, projectIds, roleByProjectId, userId]);
}

export { useProjectRolesMap };
