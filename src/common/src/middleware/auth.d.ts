import { Request, Response, NextFunction } from 'express';
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
declare global {
    namespace Express {
        interface Request {
            user?: UserClaims;
        }
    }
}
/**
 * JWT Authentication Middleware
 * Validates JWT tokens from Keycloak and extracts user claims
 */
export declare function createAuthMiddleware(logLevel?: string): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Middleware to extract project ID from token claims for project-scoped routes
 */
export declare function extractProjectId(req: Request, res: Response, next: NextFunction): Response<any, Record<string, any>> | undefined;
//# sourceMappingURL=auth.d.ts.map