type RealmAccess = {
  roles?: string[];
};

type ResourceAccess = Record<string, { roles?: string[] } | undefined>;

type AccessTokenPayload = {
  sub?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  realm_access?: RealmAccess;
  resource_access?: ResourceAccess;
};

export type ParsedAccessTokenClaims = {
  userId: string;
  name?: string;
  email?: string;
  roles: string[];
  permissions: string[];
};

const AGENT_STUDIO_API_CLIENT = "agent-studio-api";

function decodeJwtPayload(accessToken: string): AccessTokenPayload | null {
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json = atob(padded);
    return JSON.parse(json) as AccessTokenPayload;
  } catch {
    return null;
  }
}

function uniqueRoles(realmRoles: string[], clientRoles: string[]): string[] {
  return [...new Set([...realmRoles, ...clientRoles])];
}

/**
 * UI-only permission hints from Keycloak roles. APIs must enforce authorization;
 * keep in sync with backend role → permission mapping.
 */
function permissionsFromRoles(roles: readonly string[]): string[] {
  if (roles.includes("platform-admin")) {
    return ["admin:manage", "data:read"];
  }
  if (roles.includes("platform-member")) {
    return ["data:read"];
  }
  return [];
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value != null && value.trim() !== "")?.trim();
}

/**
 * Reads claims from a JWT access token without signature verification.
 * Use only for client UX (headers, route guards). Never trust for security decisions.
 */
export function parseAccessTokenClaims(accessToken: string): ParsedAccessTokenClaims | null {
  const payload = decodeJwtPayload(accessToken);
  if (payload?.sub == null || payload.sub === "") {
    return null;
  }

  const realmRoles = payload.realm_access?.roles ?? [];
  const clientRoles = payload.resource_access?.[AGENT_STUDIO_API_CLIENT]?.roles ?? [];
  const roles = uniqueRoles(realmRoles, clientRoles);

  return {
    userId: payload.sub,
    name: firstNonEmpty(payload.name, payload.preferred_username, payload.email, payload.sub),
    email: payload.email,
    roles,
    permissions: permissionsFromRoles(roles),
  };
}

export function getUserIdFromAccessToken(accessToken: string | null): string | null {
  if (accessToken == null) {
    return null;
  }
  return parseAccessTokenClaims(accessToken)?.userId ?? null;
}

export function getDisplayNameFromAccessToken(accessToken: string | null): string | null {
  if (accessToken == null) {
    return null;
  }
  return parseAccessTokenClaims(accessToken)?.name ?? null;
}
