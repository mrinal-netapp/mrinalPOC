// Service-account auth for outbound calls to config-service.
//
// config-service mounts `createAuthMiddleware` (src/common/src/middleware/auth.ts)
// which expects every request on `/api/v1/projects/...` routes to carry a
// `Authorization: Bearer <jwt>` issued by Keycloak. The eval-worker
// authenticates as itself via OAuth2 client-credentials and caches the
// resulting token for the worker's lifetime.
//
// Mirrors `@agentstudio/common`'s `ServiceAccountClient` minus the axios
// dependency — the worker keeps its dep footprint small (only got + the
// Temporal SDK).
//
// Env (all three required to enable auth; otherwise calls go out
// unauthenticated, which is fine for dev / mock mode against a
// non-Keycloak config-service):
//   - KEYCLOAK_INTERNAL_ISSUER (preferred) or KEYCLOAK_ISSUER
//   - KEYCLOAK_CLIENT_ID
//   - KEYCLOAK_CLIENT_SECRET

import got from 'got';
import { getLogger } from './logger';

const logger = getLogger('server');

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

let cachedToken: string | null = null;
let expiresAtMs = 0;
let inflight: Promise<string | null> | null = null;

function readEnv(): {
  issuer: string;
  clientId: string;
  clientSecret: string;
} | null {
  const issuer =
    process.env['KEYCLOAK_INTERNAL_ISSUER'] || process.env['KEYCLOAK_ISSUER'];
  const clientId = process.env['KEYCLOAK_CLIENT_ID'];
  const clientSecret = process.env['KEYCLOAK_CLIENT_SECRET'];
  if (!issuer || !clientId || !clientSecret) return null;
  return { issuer: issuer.replace(/\/$/, ''), clientId, clientSecret };
}

/**
 * Fetch (or return cached) service-account access token. Returns `null`
 * when Keycloak env is not configured — callers should treat that as
 * "auth is off in this environment" and send the request unsigned.
 *
 * Refreshes 60s before the Keycloak-reported expiry so we never present
 * a token that fails right at the receiving end.
 */
export async function getServiceAccountToken(): Promise<string | null> {
  const env = readEnv();
  if (!env) return null;

  if (cachedToken && Date.now() < expiresAtMs) {
    return cachedToken;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const tokenUrl = `${env.issuer}/protocol/openid-connect/token`;
    try {
      const res = await got.post<TokenResponse>(tokenUrl, {
        form: {
          grant_type: 'client_credentials',
          client_id: env.clientId,
          client_secret: env.clientSecret,
          scope: 'openid profile email',
        },
        responseType: 'json',
        retry: { limit: 0 },
        timeout: { request: 10_000 },
        throwHttpErrors: true,
      });
      const token = res.body?.access_token;
      if (!token) {
        throw new Error('Keycloak response missing access_token');
      }
      cachedToken = token;
      const ttlSeconds = res.body?.expires_in ?? 3600;
      expiresAtMs = Date.now() + ttlSeconds * 1000 - 60_000;
      logger.info(
        `service-account token refreshed (expires in ${ttlSeconds}s)`,
      );
      return token;
    } catch (err) {
      logger.error(
        `service-account token fetch failed (${tokenUrl}): ${err instanceof Error ? err.message : String(err)}`,
      );
      cachedToken = null;
      expiresAtMs = 0;
      throw err;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Convenience: returns the headers to merge into an outbound request.
 * Returns `{}` when auth is disabled in this environment so callers can
 * unconditionally spread the result.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getServiceAccountToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    // If token fetch fails the activity will error on the next 401 and
    // Temporal's retry policy will eventually re-attempt. Don't fail the
    // call here — the empty header lets the original error surface.
    return {};
  }
}

/** Test/dev helper — clears the token cache. */
export function _resetServiceAccountCache(): void {
  cachedToken = null;
  expiresAtMs = 0;
  inflight = null;
}
