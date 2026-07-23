/**
 * Keycloak OIDC toggle. Off in CI and default builds until platform auth is ready.
 *
 * Enabled only when BOTH are set through runtime config or build-time env:
 * - window.__RUNTIME_CONFIG__.authEnabled (from the AUTH_ENABLED env var, "true"/"1"), or VITE_AUTH_ENABLED
 * - window.__RUNTIME_CONFIG__.keycloakIssuer (from the KEYCLOAK_ISSUER env var, realm issuer URL), or VITE_KEYCLOAK_ISSUER
 *
 * Runtime config takes precedence so the same image can be deployed with auth
 * enabled per environment. Register redirect URIs in Keycloak before enabling.
 */
import { getRuntimeAuthConfig } from "./runtimeConfig";

function parseEnvFlag(value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === "") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }

  return undefined;
}

export function isOidcAuthEnabled(): boolean {
  const runtimeConfig = getRuntimeAuthConfig();
  const explicit = parseEnvFlag(runtimeConfig.authEnabled ?? import.meta.env.VITE_AUTH_ENABLED);
  const issuer = runtimeConfig.keycloakIssuer ?? import.meta.env.VITE_KEYCLOAK_ISSUER?.trim();

  if (explicit !== true) {
    return false;
  }

  if (!issuer) {
    return false;
  }

  return true;
}

/**
 * When true, logout calls Keycloak end-session (signoutRedirect) and returns via /auth/logout-callback.
 * Defaults to on whenever OIDC is enabled (production). Set VITE_KEYCLOAK_IDP_SIGNOUT=false for
 * local Keycloak without post-logout URIs configured.
 */
export function isKeycloakIdpSignoutEnabled(): boolean {
  const explicit = parseEnvFlag(import.meta.env.VITE_KEYCLOAK_IDP_SIGNOUT);
  if (explicit !== undefined) {
    return explicit;
  }
  return isOidcAuthEnabled();
}
