import { isEmailAddress } from "@/routes/pages/administration/administration-members.utils";

const KEYCLOAK_USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isKeycloakUserId(value: string): boolean {
  return KEYCLOAK_USER_ID_PATTERN.test(value.trim());
}

export function isMemberIdentifier(value: string): boolean {
  const trimmed = value.trim();
  return isKeycloakUserId(trimmed) || isEmailAddress(trimmed);
}

/** Accepts email or Keycloak user ID; value is sent to the API as-is. */
export function normalizeMemberUserId(
  identifier: string,
  invalidMessage = "Email address is required",
): string {
  const trimmed = identifier.trim();
  if (!trimmed) {
    throw new Error(invalidMessage);
  }

  if (!isMemberIdentifier(trimmed)) {
    throw new Error("Enter a valid email address or Keycloak user ID");
  }

  return trimmed;
}
