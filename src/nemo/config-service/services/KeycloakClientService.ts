import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import axios, { AxiosInstance } from 'axios';
import { BaseService } from './BaseService';

/**
 * Minimal Keycloak user profile, as returned by the Admin Users API. All
 * fields beyond `id` are optional because Keycloak may omit them (e.g. a user
 * with no email) and we never want a missing attribute to fail a lookup.
 */
export interface KeycloakUserProfile {
  id: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

// Max concurrent Keycloak Admin API calls for the batch user helpers
// (getUsersByIds / resolveUsers / resolveOrCreateUsers). Bounds fan-out so a
// large input array can't overwhelm Keycloak or Node's socket pool.
const USER_LOOKUP_CONCURRENCY = 10;

/**
 * Service for interacting with Keycloak Admin API
 * Used to create OIDC clients programmatically
 */
export class KeycloakClientService extends BaseService {
  private adminClient: AxiosInstance;
  private realmName: string;
  private accessToken?: string;
  private tokenExpiry?: Date;

  constructor() {
    super();
    const keycloakUrl = process.env.KEYCLOAK_INTERNAL_ISSUER?.replace('/realms/nemo', '') ||
                       process.env.KEYCLOAK_URL ||
                       'http://keycloak.agentstudio-identity.svc.cluster.local:8080';
    const adminUser = process.env.KEYCLOAK_ADMIN_USER || 'admin';
    const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD || 'AgentstudioAdmin123!';
    this.realmName = process.env.KEYCLOAK_REALM || 'nemo';

    this.adminClient = axios.create({
      baseURL: keycloakUrl,
      timeout: 30000,
    });

    // Store credentials for token refresh
    this.adminCredentials = {
      username: adminUser,
      password: adminPassword,
    };
  }

  private adminCredentials: { username: string; password: string };

  /**
   * Get admin access token from Keycloak
   */
  private async getAdminToken(): Promise<string> {
    // Check if token is still valid (with 30 second buffer)
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > new Date(Date.now() + 30000)) {
      return this.accessToken;
    }

    try {
      const response = await axios.post(
        `${this.adminClient.defaults.baseURL}/realms/master/protocol/openid-connect/token`,
        new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: this.adminCredentials.username,
          password: this.adminCredentials.password,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      this.accessToken = response.data.access_token;
      const expiresIn = response.data.expires_in || 60; // Default to 60 seconds
      this.tokenExpiry = new Date(Date.now() + expiresIn * 1000);

      if (!this.accessToken) {
        throw new Error('Failed to get access token from Keycloak');
      }
      return this.accessToken;
    } catch (error: any) {
      logger.error('[KeycloakClientService] Failed to get admin token:', error.message);
      throw new Error(`Failed to authenticate with Keycloak: ${error.message}`);
    }
  }

  /**
   * Check if a client exists
   */
  async clientExists(clientId: string): Promise<boolean> {
    try {
      const token = await this.getAdminToken();
      const response = await this.adminClient.get(
        `/admin/realms/${this.realmName}/clients`,
        {
          params: { clientId },
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return Array.isArray(response.data) && response.data.length > 0;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return false;
      }
      logger.error(`[KeycloakClientService] Error checking client existence: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get client UUID by client ID
   */
  async getClientUuid(clientId: string): Promise<string | null> {
    try {
      const token = await this.getAdminToken();
      const response = await this.adminClient.get(
        `/admin/realms/${this.realmName}/clients`,
        {
          params: { clientId },
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (Array.isArray(response.data) && response.data.length > 0) {
        return response.data[0].id;
      }
      return null;
    } catch (error: any) {
      logger.error(`[KeycloakClientService] Error getting client UUID: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get client secret
   */
  async getClientSecret(clientUuid: string): Promise<string | null> {
    try {
      const token = await this.getAdminToken();
      const response = await this.adminClient.get(
        `/admin/realms/${this.realmName}/clients/${clientUuid}/client-secret`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return response.data.value || null;
    } catch (error: any) {
      logger.error(`[KeycloakClientService] Error getting client secret: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create a service account client for a project
   */
  async createProjectServiceAccountClient(projectId: string): Promise<{ clientId: string; clientSecret: string }> {
    const clientId = `project-${projectId}-service`;

    // Check if client already exists
    const exists = await this.clientExists(clientId);
    if (exists) {
      logger.info(`[KeycloakClientService] Client ${clientId} already exists, retrieving secret...`);
      const clientUuid = await this.getClientUuid(clientId);
      if (!clientUuid) {
        throw new Error(`Client ${clientId} exists but UUID not found`);
      }
      const secret = await this.getClientSecret(clientUuid);
      if (!secret) {
        throw new Error(`Client ${clientId} exists but secret not found`);
      }
      return { clientId, clientSecret: secret };
    }

    // Create new client
    try {
      const token = await this.getAdminToken();
      const clientConfig = {
        clientId,
        enabled: true,
        publicClient: false,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: true, // Required for client credentials flow
        serviceAccountsEnabled: true, // Enable service accounts
        authorizationServicesEnabled: false,
        redirectUris: [],
        webOrigins: [],
        protocol: 'openid-connect',
        attributes: {
          'access.token.lifespan': '86400', // 24 hours
        },
      };

      const response = await this.adminClient.post(
        `/admin/realms/${this.realmName}/clients`,
        clientConfig,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.status === 201 || response.status === 409) {
        // Client created or already exists, get the secret
        const clientUuid = await this.getClientUuid(clientId);
        if (!clientUuid) {
          throw new Error(`Failed to get UUID for newly created client ${clientId}`);
        }

        // Wait a moment for Keycloak to generate the secret
        await new Promise(resolve => setTimeout(resolve, 1000));

        const secret = await this.getClientSecret(clientUuid);
        if (!secret) {
          throw new Error(`Failed to get secret for client ${clientId}`);
        }

        logger.info(`[KeycloakClientService] Created service account client ${clientId}`);
        return { clientId, clientSecret: secret };
      } else {
        throw new Error(`Unexpected status code: ${response.status}`);
      }
    } catch (error: any) {
      if (error.response?.status === 409) {
        // Client already exists, get the secret
        const clientUuid = await this.getClientUuid(clientId);
        if (!clientUuid) {
          throw new Error(`Client ${clientId} exists but UUID not found`);
        }
        const secret = await this.getClientSecret(clientUuid);
        if (!secret) {
          throw new Error(`Client ${clientId} exists but secret not found`);
        }
        return { clientId, clientSecret: secret };
      }
      logger.error(`[KeycloakClientService] Error creating client: ${error.message}`);
      if (error.response?.data) {
        logger.error(`[KeycloakClientService] Response:`, JSON.stringify(error.response.data, null, 2));
      }
      throw error;
    }
  }

  /**
   * Delete a project service account client
   */
  async deleteProjectServiceAccountClient(projectId: string): Promise<boolean> {
    const clientId = `project-${projectId}-service`;
    const clientUuid = await this.getClientUuid(clientId);

    if (!clientUuid) {
      logger.info(`[KeycloakClientService] Client ${clientId} not found, nothing to delete`);
      return false;
    }

    try {
      const token = await this.getAdminToken();
      await this.adminClient.delete(
        `/admin/realms/${this.realmName}/clients/${clientUuid}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      logger.info(`[KeycloakClientService] Deleted service account client ${clientId}`);
      return true;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return false; // Already deleted
      }
      logger.error(`[KeycloakClientService] Error deleting client: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get count of users in the realm (excluding service accounts)
   */
  async getUserCount(): Promise<number> {
    try {
      const token = await this.getAdminToken();
      const response = await this.adminClient.get(
        `/admin/realms/${this.realmName}/users`,
        {
          params: { max: 1000 }, // Get up to 1000 users to count
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!Array.isArray(response.data)) {
        return 0;
      }

      // Filter out service accounts (users with serviceAccountClientId attribute)
      const regularUsers = response.data.filter((user: any) => {
        // Service accounts typically have serviceAccountClientId set
        return !user.serviceAccountClientId;
      });

      return regularUsers.length;
    } catch (error: any) {
      if (error.response?.status === 404) {
        // Realm doesn't exist yet
        return 0;
      }
      logger.error(`[KeycloakClientService] Error getting user count: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch user profiles for the given Keycloak user ids.
   *
   * Returns a map keyed by user id. Ids that don't resolve — a deleted user
   * (404) or a transient error — are simply omitted so the caller can degrade
   * gracefully (return the member with just userId/role) rather than failing
   * the whole batch.
   *
   * Lookups fan out in bounded batches (USER_LOOKUP_CONCURRENCY at a time)
   * rather than one big Promise.all: a membership list can be up to the
   * policy-query cap (500), and issuing that many concurrent Admin API calls
   * could overwhelm Keycloak / Node's socket pool.
   */
  async getUsersByIds(ids: string[]): Promise<Map<string, KeycloakUserProfile>> {
    const profiles = new Map<string, KeycloakUserProfile>();
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return profiles;
    }

    const token = await this.getAdminToken();

    const fetchOne = async (id: string): Promise<void> => {
      try {
        const response = await this.adminClient.get(
          `/admin/realms/${this.realmName}/users/${encodeURIComponent(id)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );
        const user = response.data;
        if (user && user.id) {
          profiles.set(user.id, {
            id: user.id,
            username: user.username,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
          });
        }
      } catch (error: any) {
        // 404 means the user no longer exists (e.g. a stale policy) — skip
        // it silently. Any other error is logged but kept non-fatal so one
        // bad lookup doesn't blank out the whole members list.
        if (error.response?.status !== 404) {
          logger.error(`[KeycloakClientService] user lookup failed for ${id}: ${error.message}`);
        }
      }
    };

    for (let i = 0; i < uniqueIds.length; i += USER_LOOKUP_CONCURRENCY) {
      const batch = uniqueIds.slice(i, i + USER_LOOKUP_CONCURRENCY);
      await Promise.all(batch.map(fetchOne));
    }
    return profiles;
  }

  /**
   * Look up a user's id by exact email. Returns null when no user has that
   * email. Uses the master-admin token (which already carries view-users), so
   * no extra Keycloak role grants are required.
   */
  async getUserIdByEmail(email: string): Promise<string | null> {
    const token = await this.getAdminToken();
    const response = await this.adminClient.get(
      `/admin/realms/${this.realmName}/users`,
      {
        params: { email, exact: true },
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const users = Array.isArray(response.data) ? response.data : [];
    if (users.length === 0) {
      return null;
    }
    if (users.length > 1) {
      // duplicateEmailsAllowed:false makes >1 unexpected; log and use the first.
      logger.warn(
        `[KeycloakClientService] ${users.length} users found for email ${email}; using first`
      );
    }
    return users[0].id ?? null;
  }

  /**
   * Create a Keycloak user for the given email. `username` = email and
   * `emailVerified` = true so the invitee passes the idp email-verification
   * sub-step on first Entra login (with Entra trustEmail:true). Returns the
   * new user id. A 409 Conflict (created concurrently / already exists) is
   * non-fatal — we fall back to a lookup so the call is race-safe.
   */
  async createUser(email: string): Promise<string> {
    const token = await this.getAdminToken();
    try {
      const response = await this.adminClient.post(
        `/admin/realms/${this.realmName}/users`,
        { username: email, email, enabled: true, emailVerified: true },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      // Keycloak returns 201 with the new id in the Location header.
      const location: string | undefined = response.headers?.location;
      const idFromLocation = location ? location.split('/').pop() : undefined;
      if (idFromLocation) {
        return idFromLocation;
      }
      // No Location header (some Keycloak builds) — re-query by email.
      const id = await this.getUserIdByEmail(email);
      if (!id) {
        throw new Error(`User created for ${email} but id could not be resolved`);
      }
      return id;
    } catch (error: any) {
      if (error.response?.status === 409) {
        const id = await this.getUserIdByEmail(email);
        if (id) {
          return id;
        }
      }
      logger.error(`[KeycloakClientService] Error creating user ${email}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Resolve an email to a Keycloak user id, creating the user if it does not
   * exist yet (lazy first-broker-login means a never-logged-in invitee has no
   * user row). Race-safe via createUser's 409 fallback.
   */
  async resolveOrCreateUser(email: string): Promise<{ userId: string; created: boolean }> {
    const existing = await this.getUserIdByEmail(email);
    if (existing) {
      return { userId: existing, created: false };
    }
    const userId = await this.createUser(email);
    return { userId, created: true };
  }

  /**
   * Batch resolve-or-create. Dedupes the input emails and fans out
   * concurrently (mirrors getUsersByIds). Returns a map keyed by input email.
   */
  async resolveOrCreateUsers(
    emails: string[]
  ): Promise<Map<string, { userId: string; created: boolean }>> {
    const result = new Map<string, { userId: string; created: boolean }>();
    const unique = [...new Set(emails)];
    // Bounded fan-out: this is a generic helper that could be called with a
    // large array, so cap concurrent Keycloak Admin calls (mirrors
    // getUsersByIds) instead of an unbounded Promise.all.
    for (let i = 0; i < unique.length; i += USER_LOOKUP_CONCURRENCY) {
      const batch = unique.slice(i, i + USER_LOOKUP_CONCURRENCY);
      await Promise.all(
        batch.map(async (email) => {
          result.set(email, await this.resolveOrCreateUser(email));
        })
      );
    }
    return result;
  }

  /**
   * Batch resolve-ONLY: look up each email's userId without creating anything.
   * Returns a map keyed by input email; the value is the userId or null when no
   * user has that email. Used by the change-role / remove-member write paths,
   * which must 404 on an unknown email rather than silently provisioning one.
   */
  async resolveUsers(emails: string[]): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const unique = [...new Set(emails)];
    // Bounded fan-out (see resolveOrCreateUsers / getUsersByIds).
    for (let i = 0; i < unique.length; i += USER_LOOKUP_CONCURRENCY) {
      const batch = unique.slice(i, i + USER_LOOKUP_CONCURRENCY);
      await Promise.all(
        batch.map(async (email) => {
          result.set(email, await this.getUserIdByEmail(email));
        })
      );
    }
    return result;
  }

  /**
   * Check if realm exists
   */
  async realmExists(): Promise<boolean> {
    try {
      const token = await this.getAdminToken();
      await this.adminClient.get(
        `/admin/realms/${this.realmName}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      return true;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return false;
      }
      logger.error(`[KeycloakClientService] Error checking realm existence: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get admin credentials (for setup page display)
   */
  getAdminCredentials(): { username: string; password: string } {
    return {
      username: this.adminCredentials.username,
      password: this.adminCredentials.password,
    };
  }
}

let cachedUserDirectory: KeycloakClientService | null = null;

/**
 * Process-wide singleton used by read routes that need to resolve Keycloak
 * user profiles (e.g. the project-members listing). Mirrors
 * getRouteKeycloakAuthzClient so routes share one admin client and its token
 * cache instead of constructing a fresh client per request.
 */
export function getRouteKeycloakUserDirectory(): KeycloakClientService {
  if (!cachedUserDirectory) {
    cachedUserDirectory = new KeycloakClientService();
  }
  return cachedUserDirectory;
}

/**
 * Test-only: replace the cached user-directory client (or clear it with null).
 */
export function _setCachedKeycloakUserDirectoryForTests(client: KeycloakClientService | null): void {
  cachedUserDirectory = client;
}
