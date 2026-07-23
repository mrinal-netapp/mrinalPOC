import { useLayoutEffect, useMemo, type ReactElement, type ReactNode } from "react";

import { clearAuthTokenBridge, setAuthTokenBridge } from "@/api/api.slice";
import { isOidcAuthEnabled } from "../authConfig";
import { useAuth } from "../hooks/useAuth";
import { startOidcLogin } from "../keycloak/oidcSession";

type ApiAuthBridgeProps = {
  children?: ReactNode;
};

/** Wires OIDC access token + refresh into RTK Query base queries. */
function ApiAuthBridge({ children }: ApiAuthBridgeProps): ReactElement {
  const { token, refreshToken } = useAuth();

  const bridge = useMemo(
    () => ({
      getAccessToken: () => token,
      refreshToken: async () => {
        return refreshToken();
      },
      onAuthFailure: () => {
        // startOidcLogin() can reject (e.g. discovery/redirect blocked by an
        // untrusted Keycloak cert). Swallowing it with `void` produced an
        // unhandled rejection and no recovery; log so the failure is visible.
        startOidcLogin().catch((err: unknown) => {
          console.error("[ApiAuthBridge] startOidcLogin failed on auth failure", err);
        });
      },
    }),
    [token, refreshToken],
  );

  useLayoutEffect(() => {
    if (isOidcAuthEnabled() && token != null) {
      setAuthTokenBridge(bridge);
      return () => clearAuthTokenBridge();
    }
    clearAuthTokenBridge();
    return () => clearAuthTokenBridge();
  }, [bridge, token]);

  return <>{children}</>;
}

export { ApiAuthBridge };
