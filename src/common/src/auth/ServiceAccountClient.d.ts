import { AxiosInstance } from 'axios';
/**
 * Service Account Client for machine-to-machine authentication
 * Uses OAuth2 client credentials flow to get access tokens from Keycloak
 */
export declare class ServiceAccountClient {
    private issuer;
    private clientId;
    private clientSecret;
    private accessToken;
    private tokenExpiresAt;
    private httpClient;
    constructor(issuer: string, clientId: string, clientSecret: string);
    /**
     * Get access token (with caching and automatic refresh)
     */
    getAccessToken(): Promise<string>;
    /**
     * Create an authenticated HTTP client with automatic token injection
     */
    createAuthenticatedClient(baseURL: string): AxiosInstance;
}
/**
 * Create a service account client from environment variables
 */
export declare function createServiceAccountClientFromEnv(): ServiceAccountClient | null;
//# sourceMappingURL=ServiceAccountClient.d.ts.map