"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthMiddleware = createAuthMiddleware;
exports.extractProjectId = extractProjectId;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const jwks_rsa_1 = __importDefault(require("jwks-rsa"));
// Create JWKS client
function createJWKSClient(issuer) {
    return (0, jwks_rsa_1.default)({
        jwksUri: `${issuer}/protocol/openid-connect/certs`,
        cache: true,
        cacheMaxAge: 3600000, // 1 hour
        rateLimit: true,
        jwksRequestsPerMinute: 5,
    });
}
/**
 * JWT Authentication Middleware
 * Validates JWT tokens from Keycloak and extracts user claims
 */
function createAuthMiddleware(logLevel = 'info') {
    const issuer = process.env.KEYCLOAK_ISSUER || '';
    if (!issuer) {
        console.warn('WARNING: KEYCLOAK_ISSUER not set, authentication disabled');
        return (req, res, next) => {
            next();
        };
    }
    // Create JWKS client ONCE so the built-in cache persists across requests.
    const jwksClientInstance = createJWKSClient(issuer);
    return async (req, res, next) => {
        // Skip auth for public endpoints
        if (shouldSkipAuth(req.path)) {
            return next();
        }
        // Extract token from Authorization header
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ error: 'Unauthorized', message: 'Missing Authorization header' });
        }
        // Parse Bearer token
        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0] !== 'Bearer') {
            return res.status(401).json({ error: 'Unauthorized', message: 'Invalid Authorization header format' });
        }
        const token = parts[1];
        try {
            const client = jwksClientInstance;
            // Decode token header to get kid
            const decodedHeader = jsonwebtoken_1.default.decode(token, { complete: true });
            if (!decodedHeader || typeof decodedHeader === 'string' || !decodedHeader.header?.kid) {
                return res.status(401).json({ error: 'Unauthorized', message: 'Invalid token format' });
            }
            // Get signing key
            const key = await new Promise((resolve, reject) => {
                client.getSigningKey(decodedHeader.header.kid, (err, signingKey) => {
                    if (err) {
                        return reject(err);
                    }
                    const publicKey = signingKey?.getPublicKey();
                    if (!publicKey) {
                        return reject(new Error('No public key found'));
                    }
                    resolve(publicKey);
                });
            });
            // Verify token
            const decoded = jsonwebtoken_1.default.verify(token, key, {
                algorithms: ['RS256'],
                issuer: issuer,
            });
            // Cast to UserClaims
            const userClaims = {
                sub: decoded.sub || '',
                email: decoded.email,
                preferred_username: decoded.preferred_username,
                name: decoded.name,
                'agentstudio.project_id': decoded['agentstudio.project_id'],
                'agentstudio.workspace_id': decoded['agentstudio.workspace_id'],
                'agentstudio.namespace_id': decoded['agentstudio.namespace_id'],
                iss: decoded.iss,
                exp: decoded.exp,
                iat: decoded.iat,
            };
            // Add user claims to request
            req.user = userClaims;
            next();
        }
        catch (error) {
            if (logLevel === 'debug') {
                console.error('Token validation error:', error);
            }
            return res.status(401).json({ error: 'Unauthorized', message: error.message || 'Token validation failed' });
        }
    };
}
/**
 * Check if authentication should be skipped for a path
 */
function shouldSkipAuth(path) {
    const publicPaths = [
        '/health',
        '/ready',
        '/swagger',
        '/docs',
        '/swagger.json',
    ];
    return publicPaths.some(publicPath => path === publicPath || path.startsWith(publicPath + '/'));
}
/**
 * Middleware to extract project ID from token claims for project-scoped routes
 */
function extractProjectId(req, res, next) {
    if (req.user && req.user['agentstudio.project_id']) {
        // Project ID is already in user claims, continue
        next();
    }
    else if (req.params.projectId) {
        // Project ID from route parameter, continue
        next();
    }
    else {
        return res.status(400).json({ error: 'Bad Request', message: 'Project ID required' });
    }
}
//# sourceMappingURL=auth.js.map