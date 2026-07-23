import type { ReactNode } from "react";

import { isAccessAllowed } from "../model/authAccess";
import type { AuthGuardProps } from "../model/auth.types";
import { useAuth } from "../hooks/useAuth";

/**
 * Renders `children` only when auth requirement and optional role/permission checks pass.
 */
function AuthGuard({
  requireAuth = true,
  roles: requiredRoles,
  permissions: requiredPermissions,
  fallback = null,
  loadingFallback = null,
  children,
}: AuthGuardProps): ReactNode {
  const { isAuthenticated, roles: userRoles, permissions: userPermissions, loading } = useAuth();
  if (loading) {
    return loadingFallback;
  }

  const allowed = isAccessAllowed({
    requireAuth,
    isAuthenticated,
    requiredRoles,
    requiredPermissions,
    userRoles,
    userPermissions,
  });

  if (!allowed) {
    return fallback;
  }

  return children;
}

export { AuthGuard };
