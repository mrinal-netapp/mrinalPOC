export const PLATFORM_ADMIN_ROLE = "platform-admin";
export const PLATFORM_MEMBER_ROLE = "platform-member";

export const PLATFORM_ROLES = [PLATFORM_ADMIN_ROLE, PLATFORM_MEMBER_ROLE] as const;

export function hasPlatformAccess(roles: readonly string[]): boolean {
  return roles.includes(PLATFORM_ADMIN_ROLE) || roles.includes(PLATFORM_MEMBER_ROLE);
}
