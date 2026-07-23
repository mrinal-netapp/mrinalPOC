import axios, { AxiosInstance } from 'axios';

/**
 * Read-only client for Keycloak Authorization Services Admin API,
 * scoped to the `usr-{userId}-proj-{projectId}-{role}` policy convention used by
 * the per-project authorization design (see docs/design/keycloak-per-project-authorization.md).
 *
 * Mirrors the shape of `internal/clients/keycloak.go::KeycloakAuthzClient` in
 * workflow-engine, but only exposes the surface the read endpoints need
 * (ListPolicies). All writes still go through workflow-engine (Temporal-backed).
 *
 * Authenticates as the `agent-studio-svc-config` service account via OAuth2
 * client_credentials. Reuses the access token across calls until ~30s before
 * expiry. The cache is a per-instance field; routes use a process-wide
 * singleton (see `getRouteKeycloakAuthzClient`) so token reuse is real.
 */
export interface PolicyInfo {
  id: string;
  name: string;
  type?: string;
}

export class KeycloakAuthzClient {
  private readonly httpClient: AxiosInstance;
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly resourceServerUUID: string;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(issuer: string, clientId: string, clientSecret: string, resourceServerUUID: string) {
    if (!issuer || !clientId || !clientSecret || !resourceServerUUID) {
      throw new Error('KeycloakAuthzClient: issuer, clientId, clientSecret, and resourceServerUUID are required');
    }
    this.issuer = issuer.replace(/\/+$/, '');
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.resourceServerUUID = resourceServerUUID;
    this.httpClient = axios.create({
      timeout: 15_000,
      validateStatus: () => true,
    });
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    const tokenUrl = `${this.issuer}/protocol/openid-connect/token`;
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      audience: 'realm-management',
    });
    const resp = await this.httpClient.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (resp.status < 200 || resp.status >= 300 || !resp.data?.access_token) {
      throw new Error(
        `KeycloakAuthzClient: token request failed (status ${resp.status}): ${typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)}`,
      );
    }
    const expiresIn: number = resp.data.expires_in ?? 60;
    this.accessToken = resp.data.access_token as string;
    this.tokenExpiresAt = Date.now() + (expiresIn * 1000) - 30_000;
    return this.accessToken;
  }

  private adminAuthzBaseURL(): string {
    // /realms/{realm}/.../resource-server/{uuid} — derive realm base by stripping `/realms/...`.
    // Issuer is e.g. `http://keycloak.../realms/nemo`. Admin base is `<keycloakRoot>/admin/realms/<realm>/clients/<uuid>/authz/resource-server`.
    const m = this.issuer.match(/^(https?:\/\/[^/]+)(?:\/.*)?\/realms\/([^/]+)$/);
    if (!m) {
      throw new Error(`KeycloakAuthzClient: cannot derive admin base from issuer ${this.issuer}`);
    }
    const root = m[1];
    const realm = m[2];
    return `${root}/admin/realms/${realm}/clients/${this.resourceServerUUID}/authz/resource-server`;
  }

  /**
   * ListPolicies searches policies by name prefix using Keycloak's
   * `?type=user&name={prefix}&search=true` query. Mirrors workflow-engine's
   * Go client exactly so semantics stay identical when callers move between
   * services.
   */
  async listPolicies(namePrefix: string, max = 200): Promise<PolicyInfo[]> {
    if (!Number.isFinite(max) || max <= 0) max = 200;
    const token = await this.getAccessToken();
    const url = `${this.adminAuthzBaseURL()}/policy?type=user&name=${encodeURIComponent(namePrefix)}&permission=false&search=true&max=${max}`;
    const resp = await this.httpClient.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status !== 200) {
      const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      throw new Error(`KeycloakAuthzClient.listPolicies: status ${resp.status}, body: ${body}`);
    }
    if (!Array.isArray(resp.data)) return [];
    return resp.data.map((p: any) => ({ id: String(p.id ?? ''), name: String(p.name ?? ''), type: p.type }));
  }
}

let cached: KeycloakAuthzClient | null = null;

/**
 * Process-wide singleton. Caches on success only so a transient misconfig at
 * startup cannot poison the cache permanently.
 */
export function getRouteKeycloakAuthzClient(): KeycloakAuthzClient {
  if (cached) return cached;

  const issuer = process.env.KEYCLOAK_INTERNAL_ISSUER;
  // Prefer dedicated authz credentials (agent-studio-svc-config) which the
  // realm bootstrap grants manage-authorization + uma_protection roles.
  const clientId = process.env.KEYCLOAK_AUTHZ_CLIENT_ID || process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_AUTHZ_CLIENT_SECRET || process.env.KEYCLOAK_CLIENT_SECRET;
  const uuid = process.env.KEYCLOAK_RESOURCE_SERVER_UUID;

  if (!issuer || !clientId || !clientSecret || !uuid) {
    throw new Error(
      'KEYCLOAK_INTERNAL_ISSUER, KEYCLOAK_AUTHZ_CLIENT_ID (or KEYCLOAK_CLIENT_ID), KEYCLOAK_AUTHZ_CLIENT_SECRET (or KEYCLOAK_CLIENT_SECRET), and KEYCLOAK_RESOURCE_SERVER_UUID must be set',
    );
  }
  cached = new KeycloakAuthzClient(issuer, clientId, clientSecret, uuid);
  return cached;
}

/**
 * Test-only: replace the cached client (or clear it with `null`).
 */
export function _setCachedKeycloakAuthzClientForTests(client: KeycloakAuthzClient | null): void {
  cached = client;
}

/**
 * Parse a Keycloak policy name following the contract
 * `usr-{userId}-proj-{projectId}-{role}`. Returns null if the name doesn't match.
 *
 * Mirrors `parsePolicyName` in workflow-engine's Go route handler, including
 * its handling of UUIDs containing hyphens (role is the last hyphen-separated
 * segment after `-proj-`).
 *
 * The role segment must be one of the known project roles (admin|member|viewer).
 * A policy whose trailing segment is anything else is not a valid membership
 * policy and yields null, so callers never forward an out-of-spec role to
 * clients (which would violate the OpenAPI/GUI `role` enum contract).
 */
const KNOWN_PROJECT_ROLES = new Set(['admin', 'member', 'viewer']);

export function parsePolicyName(name: string): { userId: string; projectId: string; role: string } | null {
  if (!name.startsWith('usr-')) return null;
  const withoutPrefix = name.slice(4);
  const projIdx = withoutPrefix.indexOf('-proj-');
  if (projIdx < 0) return null;
  const userId = withoutPrefix.slice(0, projIdx);
  const remainder = withoutPrefix.slice(projIdx + '-proj-'.length);
  const lastHyphen = remainder.lastIndexOf('-');
  if (lastHyphen < 0) return null;
  const projectId = remainder.slice(0, lastHyphen);
  const role = remainder.slice(lastHyphen + 1);
  if (!userId || !projectId || !role) return null;
  if (!KNOWN_PROJECT_ROLES.has(role)) return null;
  return { userId, projectId, role };
}
