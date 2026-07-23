/**
 * OIDC via oidc-client-ts stores users in localStorage by default (SEC-003 SPA limitation).
 * Production hardening should move tokens to httpOnly cookies via a BFF when available.
 *
 * Production Keycloak: set client attribute post.logout.redirect.uris to "+" so post-logout
 * URIs reuse Valid redirect URIs (see reference agent-studio-realm agent-studio-ui client).
 */
import type { UserManagerSettings } from "oidc-client-ts";
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

import { getAppBasePath } from "@/consts/app-base-path";
import { getRuntimeAuthConfig } from "../runtimeConfig";

const AUTH_CALLBACK_PATH = "/auth/callback";
const AUTH_SILENT_CALLBACK_PATH = "/auth/silent-callback";
const AUTH_LOGOUT_CALLBACK_PATH = "/auth/logout-callback";

function resolveIssuer(): string {
  const runtimeConfig = getRuntimeAuthConfig();
  const issuer = runtimeConfig.keycloakIssuer ?? import.meta.env.VITE_KEYCLOAK_ISSUER?.trim();
  if (!issuer) {
    throw new Error(
      "Keycloak issuer is required for OIDC login (set runtime KEYCLOAK_ISSUER or build-time VITE_KEYCLOAK_ISSUER)",
    );
  }
  return issuer.replace(/\/$/, "");
}

function resolveClientId(): string {
  const runtimeConfig = getRuntimeAuthConfig();
  return (runtimeConfig.keycloakClientId ?? import.meta.env.VITE_KEYCLOAK_CLIENT_ID?.trim()) || "agentstudio-gui";
}

function buildAuthUri(normalizedBase: string, path: string): string {
  return `${window.location.origin}${normalizedBase}${path}`;
}

function resolveUserStore(): UserManagerSettings["userStore"] | undefined {
  try {
    return new WebStorageStateStore({ store: window.localStorage });
  } catch {
    try {
      return new WebStorageStateStore({ store: window.sessionStorage });
    } catch {
      return undefined;
    }
  }
}

/** Must be allowlisted in Keycloak (redirect URIs; post-logout when attribute is "+"). */
export function resolvePostLogoutRedirectUri(logoutCallbackUri: string): string {
  const configured = import.meta.env.VITE_KEYCLOAK_POST_LOGOUT_REDIRECT_URI?.trim();
  if (configured) {
    return configured;
  }
  return logoutCallbackUri;
}

export function getKeycloakUserManagerSettings(): UserManagerSettings {
  const normalizedBase = getAppBasePath();
  const issuer = resolveIssuer();
  const clientId = resolveClientId();

  const redirectUri = buildAuthUri(normalizedBase, AUTH_CALLBACK_PATH);
  const postLogoutRedirectUri = resolvePostLogoutRedirectUri(
    buildAuthUri(normalizedBase, AUTH_LOGOUT_CALLBACK_PATH),
  );
  const silentRedirectUri = buildAuthUri(normalizedBase, AUTH_SILENT_CALLBACK_PATH);
  const userStore = resolveUserStore();

  return {
    authority: issuer,
    client_id: clientId,
    redirect_uri: redirectUri,
    post_logout_redirect_uri: postLogoutRedirectUri,
    response_type: "code",
    scope: "openid profile email",
    automaticSilentRenew: true,
    silent_redirect_uri: silentRedirectUri,
    loadUserInfo: true,
    ...(userStore ? { userStore } : {}),
    // Provide the OIDC endpoint map explicitly (mirrors the gui app) instead of
    // relying on discovery. Without metadata, oidc-client-ts must first run a
    // background fetch of `${issuer}/.well-known/openid-configuration` before it
    // can build the authorize URL. On an untrusted/self-signed Keycloak cert that
    // background fetch fails outright (ERR_CERT_AUTHORITY_INVALID) and — unlike a
    // top-level navigation — cannot show the interactive "Proceed" cert prompt, so
    // signinRedirect() rejects and the app hangs on the "Signing in" spinner.
    // With metadata present the first hop is a direct top-level navigation to the
    // authorize endpoint, so the browser shows the cert prompt just like gui does.
    // The issuer already carries the correct scheme/host/port and realm path.
    metadata: {
      issuer,
      authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
      token_endpoint: `${issuer}/protocol/openid-connect/token`,
      userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
      end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
      jwks_uri: `${issuer}/protocol/openid-connect/certs`,
    },
  };
}

let userManager: UserManager | null = null;

export function getUserManager(): UserManager {
  if (userManager == null) {
    userManager = new UserManager(getKeycloakUserManagerSettings());
  }
  return userManager;
}

/** OIDC passive callback routes — skip session restore; page handles the protocol response. */
export function isAuthCallbackPath(pathname: string): boolean {
  return (
    pathname.includes(AUTH_CALLBACK_PATH) ||
    pathname.includes(AUTH_SILENT_CALLBACK_PATH) ||
    pathname.includes(AUTH_LOGOUT_CALLBACK_PATH)
  );
}

export { AUTH_LOGOUT_CALLBACK_PATH };
