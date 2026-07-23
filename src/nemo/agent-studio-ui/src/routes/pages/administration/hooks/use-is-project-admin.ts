import { useListProjectsQuery } from "@/api/project-api.slice";
import { useAuth } from "@/contexts/auth";

/**
 * `true` when the authenticated user has the `admin` role on the given
 * project. Sourced from `GET /api/v1/projects` (caller-scoped, carries
 * `role` inline) — same single call the project switcher uses, so RTK
 * Query dedupes the request.
 *
 * Fail-closed: missing projectId, not-yet-authenticated, or any
 * non-admin role all yield `false`.
 */
function useIsProjectAdmin(projectId: string | undefined, useStubData = false): boolean {
  const { loading: authLoading } = useAuth();

  const { data } = useListProjectsQuery(undefined, {
    skip: authLoading || !projectId,
  });

  if (useStubData) return true;
  if (!projectId) return false;
  if (authLoading) return false;

  const project = data?.projects?.find((p) => p.id === projectId);
  return project?.role === "admin";
}

export { useIsProjectAdmin };
