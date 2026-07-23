import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
/**
 * HTTP client service for making requests to config-service
 */
import * as http from 'http';
import * as https from 'https';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';

export interface HttpClientConfig {
  logLevel?: string;
  useServiceAccount?: boolean; // Enable service account authentication
}

export class HttpClient {
  private serviceAccountClient: ServiceAccountClient | null = null;

  constructor(private config: HttpClientConfig) {
    // Initialize service account client if enabled
    if (config.useServiceAccount) {
      const internalIssuer = process.env.KEYCLOAK_INTERNAL_ISSUER;
      const clientId = process.env.KEYCLOAK_CLIENT_ID;
      const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;
      
      logger.info(`[HttpClient] Initializing service account authentication...`);
      logger.info(`[HttpClient] KEYCLOAK_INTERNAL_ISSUER: ${internalIssuer || 'NOT SET'}`);
      logger.info(`[HttpClient] KEYCLOAK_CLIENT_ID: ${clientId || 'NOT SET'}`);
      logger.info(`[HttpClient] KEYCLOAK_CLIENT_SECRET: ${clientSecret ? '***SET***' : 'NOT SET'}`);
      
      this.serviceAccountClient = createServiceAccountClientFromEnv();
      if (this.serviceAccountClient) {
        logger.info('[HttpClient] ✅ Service account authentication enabled');
      } else {
        logger.warn('[HttpClient] ⚠️  Service account authentication requested but credentials not available');
        logger.warn('[HttpClient] Ensure KEYCLOAK_INTERNAL_ISSUER, KEYCLOAK_CLIENT_ID, and KEYCLOAK_CLIENT_SECRET are set');
      }
    } else {
      logger.info('[HttpClient] Service account authentication disabled');
    }
  }

  /**
   * Make HTTP/HTTPS request with optional service account authentication
   */
  async request<T>(url: string, method: string = 'GET', body?: any): Promise<T> {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add Authorization header if service account client is available
    if (this.serviceAccountClient) {
      try {
        logger.info(`[HttpClient] Getting service account token for ${method} ${url}`);
        const token = await this.serviceAccountClient.getAccessToken();
        headers['Authorization'] = `Bearer ${token}`;
        logger.info(`[HttpClient] Successfully added Authorization header for ${method} ${url}`);
        if (this.config.logLevel === 'debug') {
          logger.debug(`[HttpClient] Token preview: ${token.substring(0, 20)}...`);
        }
      } catch (error: any) {
        const errorMsg = `Failed to get service account token: ${error.message}`;
        logger.error(`[HttpClient] ${errorMsg}`);
        logger.error(`[HttpClient] This will cause authentication to fail for ${method} ${url}`);
        throw new Error(errorMsg);
      }
    } else {
      logger.warn(`[HttpClient] Service account client not available - requests to ${method} ${url} will not be authenticated`);
    }

    return new Promise((resolve, reject) => {

      let bodyStr: string | undefined;
      if (body) {
        bodyStr = JSON.stringify(body);
        headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
      }

      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: headers
      };

      // Debug logging for request
      if (this.config.logLevel === 'debug') {
        logger.debug(`[HTTP Request] ${method} ${url}`);
        logger.debug(`[HTTP Request] Headers:`, JSON.stringify(headers, null, 2));
        if (bodyStr) {
          // Truncate very long bodies for readability
          const bodyPreview = bodyStr.length > 1000 
            ? bodyStr.substring(0, 1000) + `... (${bodyStr.length} chars total)`
            : bodyStr;
          logger.debug(`[HTTP Request] Body:`, bodyPreview);
        }
      }

      const requestStartTime = Date.now();
      const req = httpModule.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          const requestDuration = Date.now() - requestStartTime;
          
          // Debug logging for response
          if (this.config.logLevel === 'debug') {
            logger.debug(`[HTTP Response] ${method} ${url} | Status: ${res.statusCode} | Duration: ${requestDuration}ms`);
            logger.debug(`[HTTP Response] Headers:`, JSON.stringify(res.headers, null, 2));
            // Truncate very long responses for readability
            const responsePreview = data.length > 2000 
              ? data.substring(0, 2000) + `... (${data.length} chars total)`
              : data;
            logger.debug(`[HTTP Response] Body:`, responsePreview);
          }

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data) as T;
              resolve(parsed);
            } catch (error) {
              reject(new Error(`Failed to parse response: ${error}`));
            }
          } else {
            const error: any = new Error(`HTTP ${res.statusCode}: ${data}`);
            error.statusCode = res.statusCode;
            error.responseBody = data;
            reject(error);
          }
        });
      });

      req.on('error', (error) => {
        const requestDuration = Date.now() - requestStartTime;
        if (this.config.logLevel === 'debug') {
          logger.debug(`[HTTP Error] ${method} ${url} | Duration: ${requestDuration}ms | Error:`, error.message);
        }
        reject(error);
      });

      if (bodyStr) {
        req.write(bodyStr);
      }

      req.end();
    });
  }
}

