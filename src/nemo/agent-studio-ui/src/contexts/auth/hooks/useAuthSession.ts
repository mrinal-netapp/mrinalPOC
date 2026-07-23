import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "oidc-client-ts";

import type { AuthContextValue, AuthSessionData, AuthUser } from "../model/auth.types";
import { isOidcAuthEnabled } from "../authConfig";
import { getOverviewUrl } from "@/consts/app-base-path";
import { clearAuthTokenBridge } from "@/api/api.slice";
import { getUserManager, isAuthCallbackPath } from "../keycloak/keycloakConfig";
import { resolveDevAuthIdentity } from "../utils/resolveDevAuthIdentity";
import {
  clearOidcForceLoginFlag,
  logoutOidcSession,
  mapOidcUserToSession,
  refreshOidcSession,
  restoreOidcSession,
  shouldForceOidcLoginPrompt,
  startOidcLogin,
  type LogoutOidcResult,
} from "../keycloak/oidcSession";

const AUTH_ERROR_CODES = {
  SESSION_CHECK_FAILED: "AUTH_SESSION_CHECK_FAILED",
} as const;

/** Test seam — tests mock these without loading oidc-client-ts. */
const authSessionApi = {
  restoreSession: (): Promise<AuthSessionData | null> => restoreOidcSession(),
  logoutSession: (): Promise<LogoutOidcResult> => logoutOidcSession(),
  refreshSession: (): Promise<AuthSessionData | null> => refreshOidcSession(),
  startLogin: (): Promise<void> => startOidcLogin(),
};

type UseAuthSessionResult = Omit<AuthContextValue, "logout" | "checkAuth"> & {
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  refreshToken: () => Promise<string | null>;
};

function applySession(
  session: AuthSessionData | null,
  setters: {
    setIsAuthenticated: (value: boolean) => void;
    setToken: (value: string | null) => void;
    setUser: (value: AuthUser | null) => void;
    setRoles: (value: string[]) => void;
    setPermissions: (value: string[]) => void;
  },
): void {
  if (session == null) {
    setters.setIsAuthenticated(false);
    setters.setToken(null);
    setters.setUser(null);
    setters.setRoles([]);
    setters.setPermissions([]);
    return;
  }

  setters.setIsAuthenticated(true);
  setters.setToken(session.token);
  setters.setUser(session.user);
  setters.setRoles([...session.roles]);
  setters.setPermissions([...session.permissions]);
}

function useAuthSession(): UseAuthSessionResult {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setters = useMemo(
    () => ({
      setIsAuthenticated,
      setToken,
      setUser,
      setRoles,
      setPermissions,
    }),
    [],
  );

  const applyOidcUser = useCallback(
    (oidcUser: User | null) => {
      applySession(mapOidcUserToSession(oidcUser), setters);
    },
    [setters],
  );

  const checkAuth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const session = await authSessionApi.restoreSession();
      applySession(session, setters);
    } catch (err) {
      console.error({ event: "auth.session_check_failed", error: err });
      setError(AUTH_ERROR_CODES.SESSION_CHECK_FAILED);
      applySession(null, setters);
    } finally {
      setLoading(false);
    }
  }, [setters]);

  const refreshToken = useCallback(async (): Promise<string | null> => {
    try {
      const session = await authSessionApi.refreshSession();
      if (session == null) {
        throw new Error("Silent refresh returned no session");
      }
      applySession(session, setters);
      return session.token;
    } catch (err) {
      console.error({ event: "auth.token_refresh_failed", error: err });
      try {
        await getUserManager().removeUser();
      } catch {
        // ignore
      }
      applySession(null, setters);
      throw err;
    }
  }, [setters]);

  const logout = useCallback(async () => {
    setError(null);
    applySession(null, setters);
    clearAuthTokenBridge();
    setLoading(false);

    const result = await authSessionApi.logoutSession();
    if (!result.endedIdpSession && isOidcAuthEnabled()) {
      window.location.replace(getOverviewUrl());
    }
  }, [setters]);

  useEffect(() => {
    if (!isOidcAuthEnabled()) {
      setUser(resolveDevAuthIdentity());
      setLoading(false);
      return;
    }

    const manager = getUserManager();

    const loadUser = async (): Promise<void> => {
      if (isAuthCallbackPath(window.location.pathname)) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        if (shouldForceOidcLoginPrompt()) {
          try {
            await manager.removeUser();
          } catch {
            // ignore
          }
          applySession(null, setters);
          return;
        }

        const oidcUser = await manager.getUser();
        applyOidcUser(oidcUser);
      } catch (err) {
        console.error({ event: "auth.session_check_failed", error: err });
        setError(AUTH_ERROR_CODES.SESSION_CHECK_FAILED);
        applySession(null, setters);
      } finally {
        setLoading(false);
      }
    };

    void loadUser();

    const handleUserLoaded = (loadedUser: User): void => {
      clearOidcForceLoginFlag();
      applyOidcUser(loadedUser);
      setLoading(false);
    };

    const handleUserUnloaded = (): void => {
      applySession(null, setters);
    };

    const handleAccessTokenExpired = (): void => {
      void refreshToken().catch(() => {
        if (!isAuthCallbackPath(window.location.pathname)) {
          void authSessionApi.startLogin();
        }
      });
    };

    manager.events.addUserLoaded(handleUserLoaded);
    manager.events.addUserUnloaded(handleUserUnloaded);
    manager.events.addAccessTokenExpired(handleAccessTokenExpired);

    const handlePageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        void checkAuth();
      }
    };
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      manager.events.removeUserLoaded(handleUserLoaded);
      manager.events.removeUserUnloaded(handleUserUnloaded);
      manager.events.removeAccessTokenExpired(handleAccessTokenExpired);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [applyOidcUser, checkAuth, refreshToken, setters]);

  return useMemo(
    () => ({
      isAuthenticated,
      token,
      user,
      roles,
      permissions,
      loading,
      error,
      logout,
      checkAuth,
      refreshToken,
    }),
    [checkAuth, error, isAuthenticated, loading, logout, permissions, refreshToken, roles, token, user],
  );
}

export { authSessionApi };
export { useAuthSession };
