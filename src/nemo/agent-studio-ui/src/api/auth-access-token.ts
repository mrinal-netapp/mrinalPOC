let runtimeAccessToken: string | null = null;

/** Syncs the active OIDC access token from auth session into API header resolution. */
export function setRuntimeAccessToken(token: string | null): void {
  runtimeAccessToken = token?.trim() || null;
}

/** Dev fallback via `VITE_ACCESS_TOKEN` when cookie auth is unavailable through the Vite proxy. */
export function resolveAccessToken(): string | null {
  return runtimeAccessToken ?? import.meta.env.VITE_ACCESS_TOKEN?.trim() ?? null;
}
