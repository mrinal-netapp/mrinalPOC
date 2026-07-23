export interface RuntimeAuthConfig {
  authEnabled?: string;
  keycloakIssuer?: string;
  keycloakClientId?: string;
}

declare global {
  interface Window {
    __RUNTIME_CONFIG__?: RuntimeAuthConfig;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/**
 * Runtime configuration injected by the container entrypoint.
 * Local dev falls back to import.meta.env when this object is absent.
 */
export function getRuntimeAuthConfig(): RuntimeAuthConfig {
  const config = window.__RUNTIME_CONFIG__ ?? {};
  return {
    authEnabled: nonEmpty(config.authEnabled),
    keycloakIssuer: nonEmpty(config.keycloakIssuer),
    keycloakClientId: nonEmpty(config.keycloakClientId),
  };
}
