import { Request, Response, NextFunction } from 'express';

/**
 * Middleware to enrich request with project role
 * For now, all authorized users are members of all projects with 'member' role
 * This can be enhanced later to query project_members table for actual role
 */
export async function projectRoleMiddleware(req: Request, res: Response, next: NextFunction) {
  // Only process if we have user and project context
  if (!req.user?.sub) {
    return next();
  }

  const projectId = req.user['agentstudio.project_id'] || req.headers['x-project-id'] as string;
  if (!projectId) {
    return next();
  }

  // For now, assume all authorized users are members of all projects
  // Set default role to 'member' (can be enhanced later to query project_members table)
  req.headers['x-project-role'] = 'member';

  next();
}
