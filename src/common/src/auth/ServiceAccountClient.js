"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceAccountClient = void 0;
exports.createServiceAccountClientFromEnv = createServiceAccountClientFromEnv;
const axios_1 = __importDefault(require("axios"));
/**
 * Service Account Client for machine-to-machine authentication
 * Uses OAuth2 client credentials flow to get access tokens from Keycloak
 */
class ServiceAccountClient {
    constructor(issuer, clientId, clientSecret) {
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        this.issuer = issuer;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.httpClient = axios_1.default.create({
            timeout: 10000,
        });
    }
    /**
     * Get access token (with caching and automatic refresh)
     */
    async getAccessToken() {
        // Check if we have a valid cached token
        if (this.accessToken && Date.now() < this.tokenExpiresAt) {
            return this.accessToken;
        }
        // Fetch new token using client credentials flow
        try {
            const tokenUrl = `${this.issuer}/protocol/openid-connect/token`;
            const params = new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: this.clientId,
                client_secret: this.clientSecret,
                scope: 'openid profile email',
            });
            const response = await this.httpClient.post(tokenUrl, params.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            });
            const accessToken = response.data.access_token;
            if (!accessToken || typeof accessToken !== 'string') {
                throw new Error('No access token in response');
            }
            this.accessToken = accessToken;
            // Set expiration (default to 1 hour if not provided)
            const expiresIn = response.data.expires_in || 3600;
            this.tokenExpiresAt = Date.now() + (expiresIn * 1000) - 60000; // Refresh 1 minute before expiry
            return accessToken;
        }
        catch (error) {
            throw new Error(`Failed to get service account token: ${error.message}`);
        }
    }
    /**
     * Create an authenticated HTTP client with automatic token injection
     */
    createAuthenticatedClient(baseURL) {
        const client = axios_1.default.create({
            baseURL,
            timeout: 30000,
        });
        // Add request interceptor to include token
        client.interceptors.request.use(async (config) => {
            const token = await this.getAccessToken();
            if (token && config.headers) {
                config.headers.Authorization = `Bearer ${token}`;
            }
            return config;
        });
        return client;
    }
}
exports.ServiceAccountClient = ServiceAccountClient;
/**
 * Create a service account client from environment variables
 * Prefers KEYCLOAK_INTERNAL_ISSUER for service-to-service authentication
 * Falls back to KEYCLOAK_ISSUER if internal issuer is not available
 */
function createServiceAccountClientFromEnv() {
    // Prefer internal issuer for service-to-service authentication
    const internalIssuer = process.env.KEYCLOAK_INTERNAL_ISSUER;
    const externalIssuer = process.env.KEYCLOAK_ISSUER;
    const issuer = internalIssuer || externalIssuer;
    const clientId = process.env.KEYCLOAK_CLIENT_ID;
    const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;
    if (!issuer || !clientId || !clientSecret) {
        console.warn('[ServiceAccountClient] KEYCLOAK_INTERNAL_ISSUER/KEYCLOAK_ISSUER, KEYCLOAK_CLIENT_ID, or KEYCLOAK_CLIENT_SECRET not set');
        return null;
    }
    if (!internalIssuer) {
        console.warn('[ServiceAccountClient] KEYCLOAK_INTERNAL_ISSUER not set, falling back to KEYCLOAK_ISSUER');
    }
    return new ServiceAccountClient(issuer, clientId, clientSecret);
}
//# sourceMappingURL=ServiceAccountClient.js.map