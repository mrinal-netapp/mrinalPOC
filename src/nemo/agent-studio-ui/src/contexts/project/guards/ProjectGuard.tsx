import type { ReactNode } from "react";

import { isProjectAccessAllowed } from "../model/projectAccess";
import type { ProjectGuardProps } from "../model/project.types";
import { useProject } from "../hooks/useProject";

/**
 * Renders `children` only when an active project is selected (when
 * `requireProject` is true) AND the caller's role matches any entry in
 * `requiredRoles` (case-insensitive exact match).
 */
function ProjectGuard({
  requireProject = true,
  requiredRoles,
  fallback = null,
  loadingFallback = null,
  children,
}: ProjectGuardProps): ReactNode {
  const { hasActiveProject, activeProject, loading } = useProject();

  if (loading) {
    return loadingFallback;
  }

  const allowed = isProjectAccessAllowed({
    requireProject,
    hasActiveProject,
    requiredRoles,
    // Pass the active-project membership role as a one-element list.
    // ProjectGuard intentionally doesn't union auth realm roles here —
    // its contract is "render only when the active project gives the
    // caller access," distinct from the sidebar which also wants to
    // surface platform-level items via realm roles.
    userRoles: [activeProject?.role],
  });

  if (!allowed) {
    return fallback;
  }

  return children;
}

export { ProjectGuard };
