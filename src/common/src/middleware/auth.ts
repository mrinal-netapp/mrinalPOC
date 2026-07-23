import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

export interface UserClaims {
  sub: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  'agentstudio.project_id'?: string;
  'agentstudio.workspace_id'?: string;
  'agentstudio.namespace_id'?: string;
  iss?: string;
  exp?: number;
  iat?: number;
}

// Extend Express Request to include user claims
declare global {
  namespace Express {
    interface Request {
      user?: UserClaims;
    }
  }
}

// Create JWKS client
function createJWKSClient(issuer: string, logLevel: string = 'info') {
  // Keycloak JWKS endpoint: /realms/{realm}/protocol/openid-connect/certs
  // Ensure issuer doesn't have trailing slash
  const issuerBase = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  const jwksUri = `${issuerBase}/protocol/openid-connect/certs`;
  
  if (logLevel === 'debug') {
    console.log(`[AUTH] Creating JWKS client with URI: ${jwksUri}`);
  }
  
  return jwksClient({
    jwksUri: jwksUri,
    cache: true,
    cacheMaxAge: 3600000, // 1 hour
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    requestHeaders: {}, // Additional headers if needed
    timeout: 10000, // 10 second timeout
  });
}

/**
 * JWT Authentication Middleware
 * Validates JWT tokens from Keycloak and extracts user claims
 * Uses KEYCLOAK_INTERNAL_ISSUER for all JWKS fetching and validation
 * Accepts tokens with either internal or external issuer in iss claim (for backward compatibility)
 */
export function createAuthMiddleware(logLevel: string = 'info') {
  // Use internal issuer for all service-to-service communication
  // External issuer is only used for user-facing OIDC flows
  const internalIssuer = process.env.KEYCLOAK_INTERNAL_ISSUER || '';
  const externalIssuer = process.env.KEYCLOAK_ISSUER || ''; // For backward compatibility only
  
  if (!internalIssuer) {
    console.warn('WARNING: KEYCLOAK_INTERNAL_ISSUER not set, authentication disabled');
    return (req: Request, res: Response, next: NextFunction) => {
      next();
    };
  }
  
  console.log(`[AUTH] Initializing auth middleware with internal issuer: ${internalIssuer}`);
  if (externalIssuer && externalIssuer !== internalIssuer) {
    console.log(`[AUTH] External issuer available (for token validation only): ${externalIssuer}`);
  }

  // Create JWKS client ONCE so the built-in cache persists across requests.
  // Without this, each request creates a fresh client with an empty cache,
  // causing a JWKS fetch to Keycloak on every API call and making the system
  // vulnerable to transient DNS failures (EAI_AGAIN).
  const jwksClientInstance = createJWKSClient(internalIssuer, logLevel);

  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip auth for public endpoints
    if (shouldSkipAuth(req.path)) {
      if (logLevel === 'debug') {
        console.log(`[AUTH] Skipping authentication for public path: ${req.path}`);
      }
      return next();
    }
    
    if (logLevel === 'debug') {
      console.log(`[AUTH] Authenticating request: ${req.method} ${req.path}`, {
        hasAuthHeader: !!req.headers.authorization,
        userAgent: req.headers['user-agent'],
        ip: req.ip
      });
    }

    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      if (logLevel === 'debug') {
        console.log(`[AUTH] Missing Authorization header for ${req.method} ${req.path}`);
      }
      return res.status(401).json({ 
        error: 'Unauthorized', 
        message: 'Missing Authorization header',
        path: req.path,
        method: req.method
      });
    }

    // Parse Bearer token
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid Authorization header format' });
    }

    const token = parts[1];

    try {
      // Decode token header to get kid and issuer
      const decodedHeader = jwt.decode(token, { complete: true });
      if (!decodedHeader || typeof decodedHeader === 'string' || !decodedHeader.header?.kid) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token format' });
      }

      // Decode payload to get the token's issuer
      const decodedPayload = jwt.decode(token) as jwt.JwtPayload | null;
      const tokenIssuer = decodedPayload?.iss;
      
      if (logLevel === 'debug') {
        console.log(`[AUTH] Token issuer from payload: ${tokenIssuer}`);
        console.log(`[AUTH] Using internal issuer for JWKS: ${internalIssuer}`);
      }
      
      const client = jwksClientInstance;
      
      if (logLevel === 'debug') {
        console.log(`[AUTH] Fetching signing key for kid: ${decodedHeader.header.kid}`);
      }

      // Get signing key
      const key = await new Promise<string>((resolve, reject) => {
        client.getSigningKey(decodedHeader.header.kid, (err, signingKey) => {
          if (err) {
            if (logLevel === 'debug') {
              console.error(`[AUTH] Error getting signing key:`, err);
            }
            return reject(err);
          }
          const publicKey = signingKey?.getPublicKey();
          if (!publicKey) {
            return reject(new Error('No public key found'));
          }
          if (logLevel === 'debug') {
            console.log(`[AUTH] Successfully retrieved signing key`);
          }
          resolve(publicKey);
        });
      });

      // Verify token signature first (without issuer check for flexibility)
      // We'll validate issuer ourselves to handle URL variations
      const normalizeIssuer = (iss: string) => {
        if (!iss) return '';
        // Remove trailing slashes, whitespace, and normalize
        return iss.trim().replace(/\/+$/, '').toLowerCase();
      };
      
      const validIssuers: string[] = [internalIssuer];
      if (externalIssuer && externalIssuer !== internalIssuer) {
        validIssuers.push(externalIssuer);
      }
      
      // Normalize all valid issuers for comparison
      const normalizedValidIssuers = validIssuers.map(normalizeIssuer);
      
      if (logLevel === 'debug') {
        console.log(`[AUTH] Verifying token with valid issuers: ${validIssuers.join(', ')}`);
        console.log(`[AUTH] Token issuer from payload: ${tokenIssuer}`);
      }
      
      // Verify token signature without issuer check (we'll validate issuer ourselves)
      const decoded = jwt.verify(token, key, {
        algorithms: ['RS256'],
        // Don't validate issuer here - we'll do it manually for flexibility
      }) as jwt.JwtPayload;
      
      // Validate issuer manually (allows for URL variations)
      // Accept any issuer that points to the same Keycloak realm (/realms/nemo)
      // Since we've already verified the token signature via JWKS, we can be more permissive
      // with issuer validation - Keycloak might use different issuer formats based on configuration
      if (tokenIssuer) {
        const normalizedTokenIssuer = normalizeIssuer(tokenIssuer);
        let issuerValid = normalizedValidIssuers.some(
          valid => normalizedTokenIssuer === normalizeIssuer(valid)
        );
        
        // If exact match fails, check if issuer is from the same Keycloak realm
        // This handles cases where Keycloak might use a different issuer format
        // (e.g., different protocol, port, or hostname but same realm)
        if (!issuerValid) {
          // Extract realm path from valid issuers (should be /realms/nemo)
          const realmPath = '/realms/nemo';
          const normalizedRealmPath = realmPath.toLowerCase();
          
          // Check if token issuer ends with the same realm path
          const tokenRealmMatch = normalizedTokenIssuer.endsWith(normalizedRealmPath);
          const validRealmMatch = normalizedValidIssuers.some(valid => 
            normalizeIssuer(valid).endsWith(normalizedRealmPath)
          );
          
          if (tokenRealmMatch && validRealmMatch) {
            // Same realm, accept it (Keycloak might use different frontend URL)
            // Token signature is already verified via JWKS, so this is safe
            issuerValid = true;
            if (logLevel === 'debug') {
              console.log(`[AUTH] Accepting token issuer '${tokenIssuer}' - same realm (/realms/nemo)`);
            }
          } else {
            // Also try URL variations (trailing slash, protocol differences)
            const tokenIssuerVariations = [
              tokenIssuer.replace(/\/$/, ''),
              tokenIssuer + '/',
              tokenIssuer.replace(/^https:/, 'http:'),
              tokenIssuer.replace(/^http:/, 'https:'),
            ];
            
            issuerValid = tokenIssuerVariations.some(variation => {
              const normalized = normalizeIssuer(variation);
              return normalizedValidIssuers.some(valid => normalized === normalizeIssuer(valid));
            });
            
            // If still not valid, check if token issuer contains the realm path
            // This is a fallback for cases where Keycloak uses a non-standard issuer format
            if (!issuerValid && normalizedTokenIssuer.includes(normalizedRealmPath)) {
              // Token is from the same realm, accept it
              // This is safe because we've already verified the signature via JWKS
              issuerValid = true;
              if (logLevel === 'debug') {
                console.log(`[AUTH] Accepting token issuer '${tokenIssuer}' - contains realm path`);
              }
            }
          }
        }
        
        if (!issuerValid) {
          // Log the actual token issuer for debugging
          console.error(`[AUTH] Token issuer validation failed`);
          console.error(`[AUTH] Token issuer: '${tokenIssuer}'`);
          console.error(`[AUTH] Valid issuers: ${validIssuers.join(', ')}`);
          console.error(`[AUTH] Internal issuer: ${internalIssuer}`);
          console.error(`[AUTH] External issuer: ${externalIssuer || 'not set'}`);
          
          return res.status(401).json({ 
            error: 'Unauthorized', 
            message: `jwt issuer invalid. expected: ${validIssuers.join(',')}`,
            path: req.path,
            method: req.method
          });
        } else if (logLevel === 'debug') {
          console.log(`[AUTH] Token issuer validated: ${tokenIssuer}`);
        }
      }

      // Cast to UserClaims
      const userClaims: UserClaims = {
        sub: decoded.sub || '',
        email: decoded.email,
        preferred_username: decoded.preferred_username,
        name: decoded.name,
        'agentstudio.project_id': (decoded as any)['agentstudio.project_id'],
        'agentstudio.workspace_id': (decoded as any)['agentstudio.workspace_id'],
        'agentstudio.namespace_id': (decoded as any)['agentstudio.namespace_id'],
        iss: decoded.iss,
        exp: decoded.exp,
        iat: decoded.iat,
      };

      // Add user claims to request
      req.user = userClaims;

      // Inject user identity headers for service-to-service communication
      // These headers allow downstream services to track user context
      if (userClaims.sub) {
        req.headers['x-user-id'] = userClaims.sub;
      }
      if (userClaims.email) {
        req.headers['x-user-email'] = userClaims.email;
      }
      if (userClaims.name) {
        req.headers['x-user-name'] = userClaims.name;
      }
      if (userClaims['agentstudio.project_id']) {
        req.headers['x-project-id'] = userClaims['agentstudio.project_id'];
        // Note: Project role will be determined by querying project_members table
        // This is done in a separate middleware or service layer
      }

      next();
    } catch (error: any) {
      const errorMessage = error.message || 'Token validation failed';
      if (logLevel === 'debug') {
        console.error(`[AUTH] Token validation error for ${req.method} ${req.path}:`, {
          error: errorMessage,
          errorType: error.name,
          stack: error.stack
        });
      } else {
        console.error(`[AUTH] Token validation failed for ${req.method} ${req.path}: ${errorMessage}`);
      }
      return res.status(401).json({ 
        error: 'Unauthorized', 
        message: errorMessage,
        path: req.path,
        method: req.method
      });
    }
  };
}

/**
 * Check if authentication should be skipped for a path
 */
function shouldSkipAuth(path: string): boolean {
  const publicPaths = [
    '/health',
    '/ready',
    '/swagger',
    '/docs',
    '/swagger.json',
    '/api/v1/setup', // Setup endpoint is public (first-time setup)
  ];

  return publicPaths.some(publicPath => 
    path === publicPath || path.startsWith(publicPath + '/')
  );
}

/**
 * Middleware to extract project ID from token claims for project-scoped routes
 */
export function extractProjectId(req: Request, res: Response, next: NextFunction) {
  if (req.user && req.user['agentstudio.project_id']) {
    // Project ID is already in user claims, continue
    next();
  } else if (req.params.projectId) {
    // Project ID from route parameter, continue
    next();
  } else {
    return res.status(400).json({ error: 'Bad Request', message: 'Project ID required' });
  }
}
