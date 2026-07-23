import { useEffect, useState, type ReactElement } from "react";

import { isOidcAuthEnabled } from "@/contexts/auth/authConfig";
import { completeOidcSilentCallback } from "@/contexts/auth/keycloak/oidcSession";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";

function AuthSilentCallbackPage(): ReactElement {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOidcAuthEnabled()) {
      return;
    }

    const complete = async (): Promise<void> => {
      try {
        await completeOidcSilentCallback();
      } catch (err) {
        console.error({ event: "auth.silent_callback_failed", error: err });
        setError("AUTH_SILENT_CALLBACK_FAILED");
      }
    };

    void complete();
  }, []);

  if (error != null) {
    return (
      <Spinner
        size="fullScreen"
        title="Session refresh failed"
        description="You may need to sign in again."
      />
    );
  }

  return (
    <Spinner
      size="fullScreen"
      title="Refreshing session"
      description="Please wait…"
    />
  );
}

export { AuthSilentCallbackPage };
