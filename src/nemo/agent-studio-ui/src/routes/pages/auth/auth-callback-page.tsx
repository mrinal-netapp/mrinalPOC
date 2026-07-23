import { useEffect, useRef, useState, type ReactElement } from "react";
import { useLocation, useNavigate } from "react-router";

import { isOidcAuthEnabled } from "@/contexts/auth/authConfig";
import { AUTH_RETURN_TO_KEY } from "@/contexts/auth/auth-storage";
import { completeOidcRedirectCallback } from "@/contexts/auth/keycloak/oidcSession";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { ROUTE_PATHS } from "@/routes/routes.consts";

function hasOidcCallbackParams(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("code") || params.has("error");
}

function consumeAuthReturnToPath(): string | null {
  const value = sessionStorage.getItem(AUTH_RETURN_TO_KEY);
  if (value == null) return null;
  sessionStorage.removeItem(AUTH_RETURN_TO_KEY);

  // Allow only app-internal absolute paths (no protocol-relative or external URLs).
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // Never route back into auth callback/logout endpoints.
  if (value.startsWith("/auth/")) return null;

  return value;
}

function AuthCallbackPage(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const hasStartedRef = useRef(false);

  useEffect(() => {
    if (!isOidcAuthEnabled()) {
      navigate(ROUTE_PATHS.OVERVIEW, { replace: true });
      return;
    }

    if (!hasOidcCallbackParams(location.search)) {
      navigate(ROUTE_PATHS.OVERVIEW, { replace: true });
      return;
    }

    if (hasStartedRef.current) {
      return;
    }
    hasStartedRef.current = true;

    const complete = async (): Promise<void> => {
      try {
        await completeOidcRedirectCallback();
        navigate(consumeAuthReturnToPath() ?? ROUTE_PATHS.OVERVIEW, { replace: true });
      } catch (err) {
        console.error({ event: "auth.callback_failed", error: err });
        setError("AUTH_CALLBACK_FAILED");
      }
    };

    void complete();
  }, [location.search, navigate]);

  if (error != null) {
    return (
      <Spinner
        size="fullScreen"
        title="Sign-in failed"
        description="Return to the app and try again."
      />
    );
  }

  return (
    <Spinner
      size="fullScreen"
      title="Completing sign in"
      description="Please wait…"
    />
  );
}

export { AuthCallbackPage };
