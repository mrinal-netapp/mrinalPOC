type AccessParams = {
  requireAuth: boolean;
  isAuthenticated: boolean;
  requiredRoles?: readonly string[];
  requiredPermissions?: readonly string[];
  userRoles: readonly string[];
  userPermissions: readonly string[];
};

function hasAnyMatch(requiredValues: readonly string[], userValues: readonly string[]): boolean {
  return requiredValues.some((value) => userValues.includes(value));
}

export function isAccessAllowed({
  requireAuth,
  isAuthenticated,
  requiredRoles,
  requiredPermissions,
  userRoles,
  userPermissions,
}: AccessParams): boolean {
  if (!requireAuth) {
    return true;
  }

  if (!isAuthenticated) {
    return false;
  }

  if ((requiredRoles == null || requiredRoles.length === 0) && (requiredPermissions == null || requiredPermissions.length === 0)) {
    return true;
  }

  if (requiredRoles != null && requiredRoles.length > 0 && hasAnyMatch(requiredRoles, userRoles)) {
    return true;
  }

  if (requiredPermissions != null && requiredPermissions.length > 0) {
    return hasAnyMatch(requiredPermissions, userPermissions);
  }

  return false;
}
