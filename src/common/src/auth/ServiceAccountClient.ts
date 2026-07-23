import axios, { AxiosInstance } from 'axios';

/**
 * Service Account Client for machine-to-machine authentication
 * Uses OAuth2 client credentials flow to get access tokens from Keycloak
 */
export class ServiceAccountClient {
  private issuer: string;
  private clientId: string;
  private clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private httpClient: AxiosInstance;

  constructor(issuer: string, clientId: string, clientSecret: string) {
    // Keycloak issuer format: http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo (internal)
    // or https://auth.agentstudio.local:8443/realms/nemo (external)
    // Use as-is, no need to remove suffix
    this.issuer = issuer;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.httpClient = axios.create({
      timeout: 10000,
      // Disable automatic redirects to avoid issues
      maxRedirects: 0,
      // Validate status to catch errors early
      validateStatus: (status) => status >= 200 && status < 300,
    });
    
    console.log(`[ServiceAccountClient] Initialized with issuer: ${this.issuer}`);
  }

  /**
   * Get access token (with caching and automatic refresh)
   */
  async getAccessToken(): Promise<string> {
    // Check if we have a valid cached token
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      console.log(`[ServiceAccountClient] Using cached access token (expires in ${Math.round((this.tokenExpiresAt - Date.now()) / 1000)}s)`);
      return this.accessToken;
    }

    // Fetch new token using client credentials flow
    // Keycloak token endpoint: /realms/{realm}/protocol/openid-connect/token
    try {
      // Ensure issuer URL doesn't have trailing slash
      const issuerBase = this.issuer.endsWith('/') ? this.issuer.slice(0, -1) : this.issuer;
      const tokenUrl = `${issuerBase}/protocol/openid-connect/token`;
      
      console.log(`[ServiceAccountClient] Requesting access token from: ${tokenUrl}`);
      console.log(`[ServiceAccountClient] Issuer base: ${issuerBase}`);
      console.log(`[ServiceAccountClient] Client ID: ${this.clientId}`);
      
      // Validate URL format
      try {
        const urlObj = new URL(tokenUrl);
        console.log(`[ServiceAccountClient] Parsed URL - Protocol: ${urlObj.protocol}, Host: ${urlObj.host}, Path: ${urlObj.pathname}`);
      } catch (urlError: any) {
        console.error(`[ServiceAccountClient] Invalid token URL format: ${tokenUrl}`);
        throw new Error(`Invalid issuer URL format: ${this.issuer}`);
      }
      
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'openid profile email',
      });

      console.log(`[ServiceAccountClient] Making POST request to ${tokenUrl}...`);
      const response = await this.httpClient.post(tokenUrl, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      const accessToken: string = response.data.access_token;
      if (!accessToken || typeof accessToken !== 'string') {
        throw new Error('No access token in response');
      }
      
      this.accessToken = accessToken;
      // Set expiration (default to 1 hour if not provided)
      const expiresIn = response.data.expires_in || 3600;
      this.tokenExpiresAt = Date.now() + (expiresIn * 1000) - 60000; // Refresh 1 minute before expiry

      console.log(`[ServiceAccountClient] Successfully obtained access token (expires in ${expiresIn}s)`);
      return accessToken;
    } catch (error: any) {
      const errorDetails = error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message;
      console.error(`[ServiceAccountClient] Failed to get access token from ${this.issuer}/protocol/openid-connect/token: ${errorDetails}`);
      if (error.code) {
        console.error(`[ServiceAccountClient] Error code: ${error.code}`);
      }
      if (error.config?.url) {
        console.error(`[ServiceAccountClient] Request URL: ${error.config.url}`);
      }
      throw new Error(`Failed to get service account token: ${errorDetails}`);
    }
  }

  /**
   * Create an authenticated HTTP client with automatic token injection
   * Optionally forwards user identity headers for service-to-service communication
   */
  createAuthenticatedClient(baseURL: string, forwardUserHeaders: boolean = true): AxiosInstance {
    const client = axios.create({
      baseURL,
      timeout: 30000,
    });

    // Add request interceptor to include token and forward user identity headers
    client.interceptors.request.use(async (config) => {
      const token = await this.getAccessToken();
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      
      // Forward user identity headers if enabled and available
      // These headers allow downstream services to track user context
      if (forwardUserHeaders && config.headers) {
        const userHeaders = [
          'x-user-id',
          'x-user-email',
          'x-user-name',
          'x-project-id',
          'x-project-role'
        ];
        
        // Forward headers if they're present in the config
        userHeaders.forEach(headerName => {
          const headerValue = (config.headers as any)[headerName] || 
                             (config.headers as any)[headerName.toLowerCase()];
          if (headerValue) {
            config.headers[headerName] = headerValue;
          }
        });
      }
      
      return config;
    });

    return client;
  }
}

/**
 * Create a service account client from environment variables
 * Always uses KEYCLOAK_INTERNAL_ISSUER for service-to-service authentication
 * This ensures service accounts can authenticate inside Kubernetes pods
 */
export function createServiceAccountClientFromEnv(): ServiceAccountClient | null {
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
