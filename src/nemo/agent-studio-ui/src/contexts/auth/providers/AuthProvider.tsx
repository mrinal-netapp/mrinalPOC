import { useEffect, useMemo, type ReactElement, type ReactNode } from "react";

import { setRuntimeAccessToken } from "@/api/auth-access-token";
import { AuthContext } from "../model/context";
import type { AuthContextValue } from "../model/auth.types";
import { useAuthSession } from "../hooks/useAuthSession";

type AuthProviderProps = { children?: ReactNode };

/** Maps auth session state into React context for `AuthGuard`, `AuthDisable`, and `useAuth`. */
function AuthProvider({ children }: AuthProviderProps): ReactElement {
  const {
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
  } = useAuthSession();

  useEffect(() => {
    setRuntimeAccessToken(token);
    return () => setRuntimeAccessToken(null);
  }, [token]);

  const value = useMemo(
    (): AuthContextValue => ({
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
    [
      checkAuth,
      error,
      isAuthenticated,
      loading,
      logout,
      permissions,
      refreshToken,
      roles,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export { AuthProvider };
