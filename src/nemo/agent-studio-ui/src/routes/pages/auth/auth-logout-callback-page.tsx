import { useEffect, useRef, type ReactElement } from "react";
import { useNavigate } from "react-router";

import { isOidcAuthEnabled } from "@/contexts/auth/authConfig";
import { completeOidcSignoutRedirectCallback } from "@/contexts/auth/keycloak/oidcSession";
import { ROUTE_PATHS } from "@/routes/routes.consts";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";

function AuthLogoutCallbackPage(): ReactElement {
  const navigate = useNavigate();
  const hasStartedRef = useRef(false);

  useEffect(() => {
    if (!isOidcAuthEnabled()) {
      navigate(ROUTE_PATHS.OVERVIEW, { replace: true });
      return;
    }

    if (hasStartedRef.current) {
      return;
    }
    hasStartedRef.current = true;

    const complete = async (): Promise<void> => {
      try {
        await completeOidcSignoutRedirectCallback();
      } catch (err) {
        console.error({ event: "auth.logout_callback_failed", error: err });
      } finally {
        navigate(ROUTE_PATHS.OVERVIEW, { replace: true });
      }
    };

    void complete();
  }, [navigate]);

  return (
    <Spinner
      size="fullScreen"
      title="Signing out"
      description="Completing sign out…"
    />
  );
}

export { AuthLogoutCallbackPage };
