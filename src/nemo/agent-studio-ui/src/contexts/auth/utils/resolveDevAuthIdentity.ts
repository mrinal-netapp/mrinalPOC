import { resolveAccessToken } from "@/api/auth-access-token";
import { DEFAULT_NEMO_CONTEXT } from "@/consts/api.consts";
import type { AuthUser } from "../model/auth.types";
import { parseAccessTokenClaims } from "@/utils/accessTokenClaims";

/** Dev/OIDC-off identity for local runs without a live Keycloak session. */
export function resolveDevAuthIdentity(): AuthUser | null {
  const token = resolveAccessToken();
  const claims = token ? parseAccessTokenClaims(token) : null;
  if (claims?.userId) {
    return { id: claims.userId, email: claims.email };
  }

  const fallbackUserId = DEFAULT_NEMO_CONTEXT.user_id.trim();
  return fallbackUserId ? { id: fallbackUserId } : null;
}
