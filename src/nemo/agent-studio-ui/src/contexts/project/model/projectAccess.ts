/**
 * Project role gating uses case-insensitive exact match against the
 * user's role string. To include multiple roles, list each explicitly:
 *
 *   requiredRoles: ["admin", "member"]   // admins + members
 *   requiredRoles: ["admin"]             // admins only
 *
 * No hierarchy / rank is applied here. Backend `permissionsGuard` enforces
 * its own admin ⊇ member ⊇ viewer ranking on the server; the frontend
 * decides what the UI shows independently.
 */

type ProjectAccessParams = {
  requireProject: boolean;
  hasActiveProject: boolean;
  requiredRoles?: readonly string[];
  /**
   * Roles to match `requiredRoles` against. Pass the union of all role
   * sources that should grant access — typically the user's active
   * project membership role for project-scoped items, plus the user's
   * realm roles (from auth) for platform-scoped items so e.g.
   * `super-admin` realm roles can unlock platform pages even with no
   * active project selected. Null / empty / whitespace entries are
   * filtered before comparison so callers can pass nullable fields
   * directly without pre-filtering.
   */
  userRoles: readonly (string | null | undefined)[];
};

function normalize(role: string | null | undefined): string | null {
  if (role == null) return null;
  const trimmed = role.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

/** Case-insensitive equality between two role strings. */
export function rolesEqual(a: string | null, b: string | null): boolean {
  const left = normalize(a);
  const right = normalize(b);
  return left != null && right != null && left === right;
}

/** True if the user's role matches ANY entry in `requiredRoles` (exact, case-insensitive). */
export function hasAnyRole(
  userRole: string | null,
  requiredRoles: readonly string[],
): boolean {
  const user = normalize(userRole);
  if (user == null) return false;
  return requiredRoles.some((role) => normalize(role) === user);
}

export function isProjectAccessAllowed({
  requireProject,
  hasActiveProject,
  requiredRoles,
  userRoles,
}: ProjectAccessParams): boolean {
  // Project-presence gate (only applies when the item is project-scoped).
  if (requireProject && !hasActiveProject) {
    return false;
  }

  // Role gate. Runs regardless of `requireProject` — a platform item
  // still has to match its `requiredRoles` against whatever role
  // sources the caller passed. Previously this was skipped entirely
  // when `requireProject` was false, which let any user reach
  // role-gated platform pages like Administration / super-admin views.
  if (requiredRoles == null || requiredRoles.length === 0) {
    return true;
  }

  return userRoles.some((role) => hasAnyRole(role ?? null, requiredRoles));
}
