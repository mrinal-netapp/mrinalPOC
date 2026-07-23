import { useEffect, useState, type ReactElement } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";

import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { ROUTE_PATHS } from "@/routes/routes.consts";
import { isOidcAuthEnabled } from "../authConfig";
import { AUTH_RETURN_TO_KEY } from "../auth-storage";
import { useAuth } from "../hooks/useAuth";
import { startOidcLogin } from "../keycloak/oidcSession";
import { hasPlatformAccess } from "../keycloak/platformAccess";
import { AccessDenied } from "../components/AccessDenied";

function isOverviewPathname(pathname: string): boolean {
  const normalized = pathname.replace(/\/$/, "") || "/";
  return normalized === ROUTE_PATHS.OVERVIEW || normalized.endsWith(ROUTE_PATHS.OVERVIEW);
}

const SIGN_IN_ERROR_TITLE = "Can’t reach sign-in";
const SIGN_IN_ERROR_DESCRIPTION =
  "We couldn’t start the sign-in process because the secure connection could not be established. " +
  "This usually means the security certificate isn’t trusted by this browser. " +
  "If the problem persists, contact your administrator.";

function AppAuthGate(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const oidcEnabled = isOidcAuthEnabled();
  const { isAuthenticated, loading, roles, error } = useAuth();
  // Captures a rejected startOidcLogin() (e.g. discovery/redirect fetch failed on
  // an untrusted cert). Without this, the rejection was swallowed by `void` and
  // the guard stayed on the "Signing in" spinner indefinitely.
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => {
    if (!oidcEnabled || loading || isAuthenticated) {
      return;
    }

    if (!isOverviewPathname(location.pathname)) {
      const returnTo = `${location.pathname}${location.search}${location.hash}`;
      sessionStorage.setItem(AUTH_RETURN_TO_KEY, returnTo);
      navigate(ROUTE_PATHS.OVERVIEW, { replace: true });
      return;
    }

    startOidcLogin().catch((err: unknown) => {
      setSignInError(err instanceof Error ? err.message : "sign_in_failed");
    });
  }, [isAuthenticated, loading, location.hash, location.pathname, location.search, navigate, oidcEnabled]);

  if (!oidcEnabled) {
    return <Outlet />;
  }

  if (signInError != null && !isAuthenticated) {
    return (
      <AccessDenied
        title={SIGN_IN_ERROR_TITLE}
        description={SIGN_IN_ERROR_DESCRIPTION}
        errorCode={signInError}
      />
    );
  }

  if (loading || !isAuthenticated) {
    return (
      <Spinner
        size="fullScreen"
        title="Signing in"
        description="Redirecting to sign in…"
      />
    );
  }

  if (!hasPlatformAccess(roles)) {
    return <AccessDenied errorCode={error} />;
  }

  return <Outlet />;
}

export { AppAuthGate };
