import type { User, UserManager } from "oidc-client-ts";

import type { AuthSessionData } from "../model/auth.types";
import { isKeycloakIdpSignoutEnabled } from "../authConfig";
import { getUserManager, resolvePostLogoutRedirectUri } from "./keycloakConfig";
import { parseAccessTokenClaims } from "@/utils/accessTokenClaims";

const FORCE_LOGIN_STORAGE_KEY = "auth.force_login";

export function markOidcForceLoginOnNextRedirect(): void {
  localStorage.setItem(FORCE_LOGIN_STORAGE_KEY, "1");
}

export function shouldForceOidcLoginPrompt(): boolean {
  return localStorage.getItem(FORCE_LOGIN_STORAGE_KEY) === "1";
}

export function clearOidcForceLoginFlag(): void {
  localStorage.removeItem(FORCE_LOGIN_STORAGE_KEY);
}

export function mapOidcUserToSession(oidcUser: User | null): AuthSessionData | null {
  if (oidcUser?.access_token == null) {
    return null;
  }

  const claims = parseAccessTokenClaims(oidcUser.access_token);
  if (claims == null) {
    return null;
  }

  return {
    token: oidcUser.access_token,
    user: {
      id: claims.userId,
      name: oidcUser.profile?.name,
      given_name: oidcUser.profile?.given_name,
      family_name: oidcUser.profile?.family_name,
      email: oidcUser.profile?.email ?? claims.email,
    },
    roles: claims.roles,
    permissions: claims.permissions,
  };
}

export async function restoreOidcSession(): Promise<AuthSessionData | null> {
  if (shouldForceOidcLoginPrompt()) {
    return null;
  }

  const manager = getUserManager();
  const oidcUser = await manager.getUser();
  return mapOidcUserToSession(oidcUser);
}

export async function refreshOidcSession(): Promise<AuthSessionData | null> {
  const manager = getUserManager();
  const oidcUser = await manager.signinSilent();
  return mapOidcUserToSession(oidcUser);
}

export type LogoutOidcResult = {
  endedIdpSession: boolean;
};

const TOKEN_REVOKE_TIMEOUT_MS = 3_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId as ReturnType<typeof setTimeout>);
  });
}

function isOidcStorageKey(key: string): boolean {
  return key.startsWith("oidc.");
}

/** oidc-client-ts stores users in localStorage; protocol state uses sessionStorage. */
function purgeOidcBrowserStorage(): void {
  [localStorage, sessionStorage].forEach((storage) => {
    const keysToRemove: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key != null && isOidcStorageKey(key)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => {
      storage.removeItem(key);
    });
  });
}

/** Best-effort server-side revocation; logout must still proceed if it fails. */
async function revokeOidcTokens(manager: UserManager): Promise<void> {
  try {
    await withTimeout(
      manager.revokeTokens(["access_token", "refresh_token"]),
      TOKEN_REVOKE_TIMEOUT_MS,
      "Timed out revoking OIDC tokens",
    );
  } catch (err) {
    console.error({ event: "auth.token_revoke_failed", error: err });
  }
}

/**
 * Clears local OIDC storage, ends Keycloak SSO when possible, and keeps force-login
 * until the user signs in again successfully.
 */
export async function logoutOidcSession(): Promise<LogoutOidcResult> {
  markOidcForceLoginOnNextRedirect();
  const manager = getUserManager();
  const user = await manager.getUser();
  const idTokenHint = user?.id_token;

  await revokeOidcTokens(manager);
  await manager.removeUser();
  purgeOidcBrowserStorage();

  if (!isKeycloakIdpSignoutEnabled() || idTokenHint == null) {
    return { endedIdpSession: false };
  }

  const postLogoutRedirectUri =
    manager.settings.post_logout_redirect_uri ??
    resolvePostLogoutRedirectUri(manager.settings.redirect_uri);

  try {
    await manager.signoutRedirect({
      id_token_hint: idTokenHint,
      post_logout_redirect_uri: postLogoutRedirectUri,
    });
    return { endedIdpSession: true };
  } catch (err) {
    console.error({ event: "auth.idp_signout_failed", error: err });
    return { endedIdpSession: false };
  }
}

export async function startOidcLogin(): Promise<void> {
  const manager = getUserManager();
  if (shouldForceOidcLoginPrompt()) {
    await manager.signinRedirect({
      extraQueryParams: {
        prompt: "login",
        max_age: "0",
      },
    });
    return;
  }
  await manager.signinRedirect();
}

let redirectCallbackInFlight: Promise<User> | null = null;
let silentCallbackInFlight: Promise<User> | null = null;

/**
 * Completes the OIDC redirect callback. Idempotent for React StrictMode
 * (dev double-mount): reuses an in-flight exchange and skips when a user
 * is already stored from a prior successful callback.
 */
export async function completeOidcRedirectCallback(): Promise<User> {
  const manager = getUserManager();
  const existingUser = await manager.getUser();
  if (existingUser?.access_token != null) {
    clearOidcForceLoginFlag();
    return existingUser;
  }

  if (redirectCallbackInFlight == null) {
    redirectCallbackInFlight = (async (): Promise<User> => {
      try {
        const user = await manager.signinRedirectCallback();
        if (user == null) {
          throw new Error("OIDC redirect callback returned no user");
        }
        clearOidcForceLoginFlag();
        return user;
      } finally {
        redirectCallbackInFlight = null;
      }
    })();
  }

  return redirectCallbackInFlight;
}

/**
 * Completes the silent-renew iframe callback (StrictMode-safe).
 * Always runs signinSilentCallback so URL response params are processed even when
 * sessionStorage already holds a prior access token.
 */
export async function completeOidcSilentCallback(): Promise<User> {
  const manager = getUserManager();

  if (silentCallbackInFlight == null) {
    silentCallbackInFlight = (async (): Promise<User> => {
      try {
        const user = await manager.signinSilentCallback();
        if (user == null) {
          throw new Error("OIDC silent callback returned no user");
        }
        return user;
      } finally {
        silentCallbackInFlight = null;
      }
    })();
  }

  return silentCallbackInFlight;
}

let signoutCallbackInFlight: Promise<void> | null = null;

/** Completes Keycloak end-session redirect; idempotent for React StrictMode. */
export async function completeOidcSignoutRedirectCallback(): Promise<void> {
  if (signoutCallbackInFlight == null) {
    signoutCallbackInFlight = (async (): Promise<void> => {
      try {
        const manager = getUserManager();
        await manager.signoutRedirectCallback();
        await manager.removeUser();
        purgeOidcBrowserStorage();
      } finally {
        signoutCallbackInFlight = null;
      }
    })();
  }

  await signoutCallbackInFlight;
}
